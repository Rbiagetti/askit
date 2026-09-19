import { createClient, type Client } from "@libsql/client";
import path from "path";
import { v4 as uuid } from "uuid";

// Overridable so benchmarks and tests can run against a throwaway copy
const DB_PATH = process.env.SB_DB_PATH || path.join(process.cwd(), "secondbrain.db");

// Same client works against a local file and against remote Turso: with no
// TURSO_* env vars set (local dev, and today's deploys) this resolves to
// `file:<DB_PATH>` and behaves exactly like the previous better-sqlite3 setup.
// On Vercel, setting TURSO_DATABASE_URL + TURSO_AUTH_TOKEN points the same
// code at a remote Turso database — no branching logic needed anywhere else.
const DB_URL = process.env.TURSO_DATABASE_URL || process.env.SB_DB_PATH_URL || `file:${DB_PATH}`;

let _client: Client | null = null;
// Memoized migration promise: guarantees migrate() runs exactly once even
// when getDb() is called concurrently by multiple in-flight requests.
let _migrated: Promise<void> | null = null;

function client(): Client {
  if (!_client) {
    _client = createClient({
      url: DB_URL,
      authToken: process.env.TURSO_AUTH_TOKEN, // ignored for "file:" URLs
      intMode: "number", // keeps the previous better-sqlite3 number semantics
    });
  }
  return _client;
}

export async function getDb(): Promise<Client> {
  const c = client();
  if (!_migrated) {
    _migrated = migrate(c).catch((err) => {
      // let the next caller retry instead of caching a permanent failure
      _migrated = null;
      throw err;
    });
  }
  await _migrated;
  return c;
}

async function migrate(c: Client): Promise<void> {
  // journal_mode is a local-file concept: Turso's remote server rejects it outright
  // ("SQL not allowed statement"), and since it lived inside the executeMultiple
  // schema block below, that one rejection silently aborted EVERY table creation —
  // discovered by testing against a real Turso database, not from the docs.
  if (DB_URL.startsWith("file:")) {
    await c.execute("PRAGMA journal_mode = WAL");
  }
  await c.execute("PRAGMA foreign_keys = ON");

  await c.executeMultiple(`

    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'note',
      domain TEXT,
      intent TEXT DEFAULT 'save',
      importance REAL DEFAULT 0.5,
      time_ref TEXT,
      time_confidence REAL DEFAULT 0,
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS item_entities (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      confidence REAL DEFAULT 1.0,
      PRIMARY KEY (item_id, entity_id)
    );

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      vector TEXT NOT NULL,
      model TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_entities_normalized ON entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_owner ON embeddings(owner_id);
    CREATE INDEX IF NOT EXISTS idx_items_type ON items(type);
    CREATE INDEX IF NOT EXISTS idx_items_domain ON items(domain);
  `);

  // Safe migrations for existing DBs — each guarded, "duplicate column" is expected
  const migrations = [
    "ALTER TABLE items ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0",
    // dim lets us invalidate every vector in bulk if the embedding model changes
    "ALTER TABLE embeddings ADD COLUMN dim INTEGER",
    // tracks whether /api/reanalyze has already re-run parseMemory on this item
    "ALTER TABLE items ADD COLUMN reanalyzed_at TEXT",
    // manual override guard (set by PATCH /api/items, see items/route.ts): when set,
    // /api/reanalyze must not overwrite domain with the model's new guess
    "ALTER TABLE items ADD COLUMN domain_locked INTEGER NOT NULL DEFAULT 0",
    // traversal goes both ways: entity -> items, not just item -> entities
    "CREATE INDEX IF NOT EXISTS idx_item_entities_entity ON item_entities(entity_id)",
    // collapse any pre-existing duplicates, then make the upserts in lib/graph.ts possible
    `DELETE FROM edges WHERE rowid NOT IN (
       SELECT MIN(rowid) FROM edges GROUP BY source_id, target_id, edge_type
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
       ON edges(source_id, target_id, edge_type)`,
    // Lexical search, to catch what embeddings miss: proper nouns, acronyms, rare terms.
    // External-content table: the rows live in items, FTS only holds the index.
    `CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
       content, raw_text,
       content='items', content_rowid='rowid',
       tokenize='unicode61 remove_diacritics 2'
     )`,
    `CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
       INSERT INTO items_fts(rowid, content, raw_text)
       VALUES (new.rowid, new.content, new.raw_text);
     END`,
    `CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
       INSERT INTO items_fts(items_fts, rowid, content, raw_text)
       VALUES ('delete', old.rowid, old.content, old.raw_text);
     END`,
    `CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
       INSERT INTO items_fts(items_fts, rowid, content, raw_text)
       VALUES ('delete', old.rowid, old.content, old.raw_text);
       INSERT INTO items_fts(rowid, content, raw_text)
       VALUES (new.rowid, new.content, new.raw_text);
     END`,
  ];
  for (const sql of migrations) {
    try {
      await c.execute(sql);
    } catch {
      // already applied
    }
  }

  // Backfill the FTS index for rows that predate it — the triggers only cover new writes.
  //
  // This cannot be detected by comparing counts: on an external-content FTS5 table
  // "SELECT COUNT(*) FROM items_fts" reads through to items, so index-empty and
  // index-full look identical. Use the schema version instead.
  //
  // PRAGMA user_version doesn't accept bound parameters, so SCHEMA_VERSION (an
  // internal constant, never user input) is interpolated directly.
  const SCHEMA_VERSION = 1;
  try {
    const versionRs = await c.execute("PRAGMA user_version");
    const current = Number(versionRs.rows[0]?.user_version ?? 0);
    if (current < SCHEMA_VERSION) {
      await c.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
      await c.execute(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  } catch {
    // FTS5 unavailable in this SQLite build — retrieval degrades to the other generators
  }
}

export async function createItem(data: {
  content: string;
  raw_text: string;
  type: string;
  domain?: string;
  intent?: string;
  importance?: number;
  time_ref?: string;
  time_confidence?: number;
}): Promise<string> {
  const db = await getDb();
  const id = uuid();
  await db.execute({
    sql: `
      INSERT INTO items (id, content, raw_text, type, domain, intent, importance, time_ref, time_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      data.content,
      data.raw_text,
      data.type,
      data.domain || null,
      data.intent || "save",
      data.importance || 0.5,
      data.time_ref || null,
      data.time_confidence || 0,
    ],
  });
  return id;
}

export async function findOrCreateEntity(name: string, type: string): Promise<string> {
  const db = await getDb();
  const normalized = name.toLowerCase().trim();
  const existingRs = await db.execute({
    sql: "SELECT id FROM entities WHERE normalized_name = ? AND type = ?",
    args: [normalized, type],
  });
  const existing = existingRs.rows[0] as unknown as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuid();
  await db.execute({
    sql: "INSERT INTO entities (id, name, normalized_name, type) VALUES (?, ?, ?, ?)",
    args: [id, name, normalized, type],
  });
  return id;
}

export async function linkItemEntity(
  itemId: string,
  entityId: string,
  confidence = 1.0
): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: "INSERT OR IGNORE INTO item_entities (item_id, entity_id, confidence) VALUES (?, ?, ?)",
    args: [itemId, entityId, confidence],
  });
}

export async function createEdge(data: {
  source_id: string;
  target_id: string;
  source_type: string;
  target_type: string;
  edge_type: string;
  weight?: number;
}): Promise<string> {
  const db = await getDb();
  const id = uuid();
  await db.execute({
    sql: `
      INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      id,
      data.source_id,
      data.target_id,
      data.source_type,
      data.target_type,
      data.edge_type,
      data.weight || 1.0,
    ],
  });
  return id;
}

/** Writes (or replaces) the embedding for an owner. One vector per owner. */
export async function saveEmbedding(
  ownerId: string,
  ownerType: string,
  vector: number[],
  model: string
): Promise<string> {
  const db = await getDb();
  const id = uuid();
  await db.batch(
    [
      {
        sql: "DELETE FROM embeddings WHERE owner_id = ? AND owner_type = ?",
        args: [ownerId, ownerType],
      },
      {
        sql: "INSERT INTO embeddings (id, owner_id, owner_type, vector, model, dim) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, ownerId, ownerType, JSON.stringify(vector), model, vector.length],
      },
    ],
    "write"
  );
  return id;
}

/** All item vectors, deserialised and filtered to the current model. */
export async function getItemVectors(
  model: string
): Promise<Array<{ itemId: string; vector: number[] }>> {
  const db = await getDb();
  const rs = await db.execute({
    sql: "SELECT owner_id, vector FROM embeddings WHERE owner_type = 'item' AND model = ?",
    args: [model],
  });
  return rs.rows.map((r) => ({
    itemId: r.owner_id as string,
    vector: JSON.parse(r.vector as string) as number[],
  }));
}

/** Ids of items that have no vector for the given model (used by the backfill). */
export async function getItemsMissingEmbedding(
  model: string
): Promise<Array<{ id: string; text: string }>> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT i.id, COALESCE(i.content, i.raw_text) AS text
          FROM items i
          LEFT JOIN embeddings e
            ON e.owner_id = i.id AND e.owner_type = 'item' AND e.model = ?
          WHERE e.id IS NULL`,
    args: [model],
  });
  return rs.rows.map((r) => ({ id: r.id as string, text: r.text as string }));
}

export async function getAllItems() {
  const db = await getDb();
  const rs = await db.execute(`
    SELECT i.*,
      GROUP_CONCAT(DISTINCT e.name || '::' || e.type) as entity_list
    FROM items i
    LEFT JOIN item_entities ie ON i.id = ie.item_id
    LEFT JOIN entities e ON ie.entity_id = e.id
    GROUP BY i.id
    ORDER BY i.created_at DESC
  `);
  return rs.rows;
}

export async function deleteItem(id: string): Promise<void> {
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM embeddings WHERE owner_id = ?", args: [id] },
      { sql: "DELETE FROM edges WHERE source_id = ? OR target_id = ?", args: [id, id] },
      { sql: "DELETE FROM items WHERE id = ?", args: [id] },
    ],
    "write"
  );
  // item_entities is cleared by ON DELETE CASCADE, but the entities themselves
  // would linger forever. Without this the table leaks on every delete.
  await pruneOrphanEntities();
}

/** Removes entities no longer referenced by any item. Returns rows deleted. */
export async function pruneOrphanEntities(): Promise<number> {
  const db = await getDb();
  const rs = await db.execute(
    "DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM item_entities)"
  );
  return rs.rowsAffected;
}

/**
 * Replaces an item's entity links with the given set, creating entities as needed
 * and keeping MENTIONS edges in sync. Returns the entity names.
 *
 * Shared by POST /api/parse and PUT /api/items, which previously each carried
 * their own copy of this logic.
 *
 * Not a single atomic client.batch(): findOrCreateEntity needs a SELECT before
 * each INSERT, so the statements can't all be known up front. The two initial
 * deletes are still batched together.
 */
export async function syncItemEntities(
  itemId: string,
  entities: Array<{ name: string; type: string }>
): Promise<string[]> {
  const db = await getDb();
  await db.batch(
    [
      { sql: "DELETE FROM item_entities WHERE item_id = ?", args: [itemId] },
      {
        sql: "DELETE FROM edges WHERE source_id = ? AND edge_type = 'MENTIONS'",
        args: [itemId],
      },
    ],
    "write"
  );

  const names: string[] = [];
  for (const ent of entities) {
    const entityId = await findOrCreateEntity(ent.name, ent.type);
    await linkItemEntity(itemId, entityId);
    await createEdge({
      source_id: itemId,
      target_id: entityId,
      source_type: "item",
      target_type: "entity",
      edge_type: "MENTIONS",
    });
    names.push(ent.name);
  }
  await pruneOrphanEntities();
  return names;
}
