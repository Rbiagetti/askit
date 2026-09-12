import Database from "better-sqlite3";
import path from "path";
import { v4 as uuid } from "uuid";

const DB_PATH = path.join(process.cwd(), "secondbrain.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    migrate(_db);
  }
  return _db;
}

function migrate(db: Database.Database) {
  db.exec(`
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
    // traversal goes both ways: entity -> items, not just item -> entities
    "CREATE INDEX IF NOT EXISTS idx_item_entities_entity ON item_entities(entity_id)",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // already applied
    }
  }
}

export function createItem(data: {
  content: string;
  raw_text: string;
  type: string;
  domain?: string;
  intent?: string;
  importance?: number;
  time_ref?: string;
  time_confidence?: number;
}) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO items (id, content, raw_text, type, domain, intent, importance, time_ref, time_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    data.content,
    data.raw_text,
    data.type,
    data.domain || null,
    data.intent || "save",
    data.importance || 0.5,
    data.time_ref || null,
    data.time_confidence || 0
  );
  return id;
}

export function findOrCreateEntity(name: string, type: string): string {
  const db = getDb();
  const normalized = name.toLowerCase().trim();
  const existing = db.prepare(
    "SELECT id FROM entities WHERE normalized_name = ? AND type = ?"
  ).get(normalized, type) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuid();
  db.prepare(
    "INSERT INTO entities (id, name, normalized_name, type) VALUES (?, ?, ?, ?)"
  ).run(id, name, normalized, type);
  return id;
}

export function linkItemEntity(itemId: string, entityId: string, confidence = 1.0) {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO item_entities (item_id, entity_id, confidence) VALUES (?, ?, ?)"
  ).run(itemId, entityId, confidence);
}

export function createEdge(data: {
  source_id: string;
  target_id: string;
  source_type: string;
  target_type: string;
  edge_type: string;
  weight?: number;
}) {
  const db = getDb();
  const id = uuid();
  db.prepare(`
    INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, data.source_id, data.target_id, data.source_type, data.target_type, data.edge_type, data.weight || 1.0);
  return id;
}

/** Writes (or replaces) the embedding for an owner. One vector per owner. */
export function saveEmbedding(
  ownerId: string,
  ownerType: string,
  vector: number[],
  model: string
) {
  const db = getDb();
  const id = uuid();
  const run = db.transaction(() => {
    db.prepare("DELETE FROM embeddings WHERE owner_id = ? AND owner_type = ?").run(
      ownerId,
      ownerType
    );
    db.prepare(
      "INSERT INTO embeddings (id, owner_id, owner_type, vector, model, dim) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(id, ownerId, ownerType, JSON.stringify(vector), model, vector.length);
  });
  run();
  return id;
}

/** All item vectors, deserialised and filtered to the current model. */
export function getItemVectors(model: string): Array<{ itemId: string; vector: number[] }> {
  const db = getDb();
  const rows = db
    .prepare("SELECT owner_id, vector FROM embeddings WHERE owner_type = 'item' AND model = ?")
    .all(model) as Array<{ owner_id: string; vector: string }>;
  return rows.map((r) => ({ itemId: r.owner_id, vector: JSON.parse(r.vector) as number[] }));
}

/** Ids of items that have no vector for the given model (used by the backfill). */
export function getItemsMissingEmbedding(model: string): Array<{ id: string; text: string }> {
  const db = getDb();
  return db
    .prepare(
      `SELECT i.id, COALESCE(i.content, i.raw_text) AS text
       FROM items i
       LEFT JOIN embeddings e
         ON e.owner_id = i.id AND e.owner_type = 'item' AND e.model = ?
       WHERE e.id IS NULL`
    )
    .all(model) as Array<{ id: string; text: string }>;
}

export function getAllItems() {
  const db = getDb();
  return db.prepare(`
    SELECT i.*,
      GROUP_CONCAT(DISTINCT e.name || '::' || e.type) as entity_list
    FROM items i
    LEFT JOIN item_entities ie ON i.id = ie.item_id
    LEFT JOIN entities e ON ie.entity_id = e.id
    GROUP BY i.id
    ORDER BY i.created_at DESC
  `).all();
}

export function getAllEmbeddings() {
  const db = getDb();
  return db.prepare("SELECT * FROM embeddings WHERE owner_type = 'item'").all() as Array<{
    id: string;
    owner_id: string;
    owner_type: string;
    vector: string;
    model: string;
  }>;
}

export function deleteItem(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM embeddings WHERE owner_id = ?").run(id);
  db.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(id, id);
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  // item_entities is cleared by ON DELETE CASCADE, but the entities themselves
  // would linger forever. Without this the table leaks on every delete.
  pruneOrphanEntities();
}

/** Removes entities no longer referenced by any item. Returns rows deleted. */
export function pruneOrphanEntities(): number {
  const db = getDb();
  const info = db
    .prepare("DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM item_entities)")
    .run();
  return info.changes;
}

/**
 * Replaces an item's entity links with the given set, creating entities as needed
 * and keeping MENTIONS edges in sync. Returns the entity names.
 *
 * Shared by POST /api/parse and PUT /api/items, which previously each carried
 * their own copy of this logic.
 */
export function syncItemEntities(
  itemId: string,
  entities: Array<{ name: string; type: string }>
): string[] {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare("DELETE FROM item_entities WHERE item_id = ?").run(itemId);
    db.prepare("DELETE FROM edges WHERE source_id = ? AND edge_type = 'MENTIONS'").run(itemId);

    const names: string[] = [];
    for (const ent of entities) {
      const entityId = findOrCreateEntity(ent.name, ent.type);
      linkItemEntity(itemId, entityId);
      createEdge({
        source_id: itemId,
        target_id: entityId,
        source_type: "item",
        target_type: "entity",
        edge_type: "MENTIONS",
      });
      names.push(ent.name);
    }
    pruneOrphanEntities();
    return names;
  });
  return run();
}

