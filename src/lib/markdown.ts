/**
 * Read-only markdown mirror of the database (PIANO.md Fase 5, option C).
 *
 * SQLite stays the source of truth; these files are a projection. That means no
 * file watcher, no write-back and no conflict resolution — in exchange for
 * portability, meaningful `git diff`s and Obsidian's graph view for free.
 * Editing a file here does nothing: the next export overwrites it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { getDb } from "./db";

const VAULT_PATH =
  process.env.VAULT_PATH || path.join(os.homedir(), "second-brain-vault");
const NOTES_DIR = "notes";
const ENTITIES_DIR = "entities";
const INDEX_FILE = ".index.json";

const VAULT_README = `# Second Brain — vault

Generata automaticamente dall'app. **Non editare i file qui dentro**: la fonte di
verità è il database SQLite, e ogni modifica fatta a mano viene sovrascritta al
prossimo export.

- \`notes/\` — una nota per file, con frontmatter e collegamenti
- \`entities/\` — pagine stub, servono a rendere le entità nodi hub nel grafo

Per rigenerare tutto: \`npm run vault:export\`
`;

interface ItemRow {
  id: string;
  content: string;
  raw_text: string;
  type: string;
  domain: string | null;
  importance: number | null;
  time_ref: string | null;
  created_at: string;
  updated_at: string;
}

type IndexMap = Record<string, string>; // itemId -> current filename (without dir)

function slugify(text: string, max = 60): string {
  const base = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return base || "nota";
}

function fileNameFor(item: ItemRow): string {
  return `${slugify(item.content || item.raw_text)}--${item.id.slice(0, 8)}.md`;
}

/** Obsidian wikilinks break on these; entity names are user data so they can contain anything. */
function safeLinkTarget(name: string): string {
  return name.replace(/[[\]|#^]/g, "").trim();
}

function yamlList(values: string[]): string {
  return values.length ? `[${values.map((v) => JSON.stringify(v)).join(", ")}]` : "[]";
}

async function readIndex(): Promise<IndexMap> {
  try {
    return JSON.parse(await fs.readFile(path.join(VAULT_PATH, INDEX_FILE), "utf8"));
  } catch {
    return {};
  }
}

async function writeIndex(index: IndexMap): Promise<void> {
  await fs.writeFile(
    path.join(VAULT_PATH, INDEX_FILE),
    JSON.stringify(index, null, 2),
    "utf8"
  );
}

async function ensureVault(): Promise<void> {
  await fs.mkdir(path.join(VAULT_PATH, NOTES_DIR), { recursive: true });
  await fs.mkdir(path.join(VAULT_PATH, ENTITIES_DIR), { recursive: true });
  await fs.writeFile(path.join(VAULT_PATH, "README.md"), VAULT_README, "utf8");
}

function loadItem(itemId: string): ItemRow | undefined {
  return getDb().prepare("SELECT * FROM items WHERE id = ?").get(itemId) as ItemRow | undefined;
}

function loadEntities(itemId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT e.name FROM entities e
         JOIN item_entities ie ON ie.entity_id = e.id
         WHERE ie.item_id = ? ORDER BY e.name`
      )
      .all(itemId) as Array<{ name: string }>
  ).map((r) => r.name);
}

function loadLinks(itemId: string): Array<{ id: string; type: string; weight: number }> {
  return getDb()
    .prepare(
      `SELECT CASE WHEN source_id = ? THEN target_id ELSE source_id END AS id,
              edge_type AS type, weight
       FROM edges
       WHERE source_type = 'item' AND target_type = 'item'
         AND (source_id = ? OR target_id = ?)
       ORDER BY weight DESC`
    )
    .all(itemId, itemId, itemId) as Array<{ id: string; type: string; weight: number }>;
}

function renderNote(item: ItemRow, entities: string[], links: Array<{ name: string; type: string; weight: number }>): string {
  const frontmatter = [
    "---",
    `id: ${item.id}`,
    `type: ${item.type}`,
    `domain: ${item.domain || "general"}`,
    `importance: ${item.importance ?? 0.5}`,
    `created: ${item.created_at}`,
    `updated: ${item.updated_at}`,
    `time_ref: ${item.time_ref || "null"}`,
    `entities: ${yamlList(entities)}`,
    "---",
  ].join("\n");

  const parts = [frontmatter, "", item.content];

  if (item.raw_text && item.raw_text.trim() !== item.content.trim()) {
    parts.push("", "> [!quote] Testo originale", `> ${item.raw_text.replace(/\n/g, "\n> ")}`);
  }

  if (links.length) {
    parts.push("", "## Collegate");
    for (const l of links) {
      const weight = l.type === "CO_OCCURS" ? `${l.weight} entità in comune` : l.weight.toFixed(2);
      parts.push(`- [[${l.name}]] — ${l.type} (${weight})`);
    }
  }

  if (entities.length) {
    parts.push("", "## Entità");
    for (const e of entities) parts.push(`- [[${safeLinkTarget(e)}]]`);
  }

  return parts.join("\n") + "\n";
}

function renderEntity(name: string, items: Array<{ file: string }>): string {
  const parts = [
    "---",
    `name: ${JSON.stringify(name)}`,
    "kind: entity",
    "---",
    "",
    `# ${name}`,
    "",
    "## Citata in",
    ...items.map((i) => `- [[${i.file.replace(/\.md$/, "")}]]`),
  ];
  return parts.join("\n") + "\n";
}

/** Ids of the items linked to this one — the notes whose wikilinks mention it. */
export function neighbourIdsOf(itemId: string): string[] {
  return loadLinks(itemId).map((l) => l.id);
}

/**
 * Writes (or deletes) the stub page for an entity.
 *
 * Stubs are what give Obsidian's graph its hubs, and they list the notes citing
 * the entity by filename — so they must be refreshed whenever one of those notes
 * is renamed, not only on a full export.
 */
async function writeEntityStub(name: string): Promise<void> {
  const file = path.join(VAULT_PATH, ENTITIES_DIR, `${safeLinkTarget(name)}.md`);
  const rows = getDb()
    .prepare(
      `SELECT ie.item_id FROM entities e
       JOIN item_entities ie ON ie.entity_id = e.id
       WHERE e.name = ?`
    )
    .all(name) as Array<{ item_id: string }>;

  // entity pruned from the DB (last citing note deleted): drop the stub
  if (rows.length === 0) {
    await fs.rm(file, { force: true });
    return;
  }

  const refs = rows
    .map((r) => loadItem(r.item_id))
    .filter((i): i is ItemRow => i !== undefined)
    .map((i) => ({ file: fileNameFor(i) }));

  await fs.writeFile(file, renderEntity(name, refs), "utf8");
}

/** Writes a single note file. Does not cascade — callers handle neighbours. */
async function writeNote(itemId: string, index: IndexMap): Promise<void> {
  const item = loadItem(itemId);
  if (!item) return;

  const fileName = fileNameFor(item);
  const previous = index[itemId];
  if (previous && previous !== fileName) {
    await fs.rm(path.join(VAULT_PATH, NOTES_DIR, previous), { force: true });
  }

  const links = loadLinks(itemId)
    .map((l) => {
      const target = loadItem(l.id);
      if (!target) return null;
      return { name: fileNameFor(target).replace(/\.md$/, ""), type: l.type, weight: l.weight };
    })
    .filter((x): x is { name: string; type: string; weight: number } => x !== null);

  await fs.writeFile(
    path.join(VAULT_PATH, NOTES_DIR, fileName),
    renderNote(item, loadEntities(itemId), links),
    "utf8"
  );
  index[itemId] = fileName;
}

/**
 * Exports one item and refreshes the notes that link to it.
 *
 * The neighbours matter: a note's filename is derived from its text, so editing
 * it renames the file and every inbound [[wikilink]] would dangle until the next
 * full export. The neighbour set is bounded by the graph, so this stays cheap.
 */
export async function exportItem(
  itemId: string,
  staleNeighbours: string[] = [],
  staleEntities: string[] = []
): Promise<void> {
  await ensureVault();
  const index = await readIndex();
  const item = loadItem(itemId);

  if (!item) {
    // deleted: drop its file, then refresh whoever used to point at it
    const stale = index[itemId];
    if (stale) {
      await fs.rm(path.join(VAULT_PATH, NOTES_DIR, stale), { force: true });
      delete index[itemId];
    }
  } else {
    await writeNote(itemId, index);
  }

  const neighbours = new Set([...staleNeighbours, ...(item ? neighbourIdsOf(itemId) : [])]);
  neighbours.delete(itemId);
  for (const id of neighbours) {
    await writeNote(id, index);
  }

  // Entity stubs reference notes by filename too, so every entity of every note
  // we just (re)wrote needs refreshing — including the deleted item's own, which
  // may now be orphaned and have to disappear.
  const touchedEntities = new Set<string>([
    ...loadEntities(itemId),
    ...[...neighbours].flatMap((id) => loadEntities(id)),
    ...staleEntities,
  ]);
  for (const name of touchedEntities) {
    await writeEntityStub(name);
  }

  await writeIndex(index);
}

/** Full regeneration: every note, every entity stub, removing whatever no longer exists. */
export async function exportAll(): Promise<{ notes: number; entities: number; removed: number }> {
  await ensureVault();
  const db = getDb();
  const items = db.prepare("SELECT * FROM items ORDER BY created_at").all() as ItemRow[];

  const index: IndexMap = {};
  const nameById = new Map(items.map((i) => [i.id, fileNameFor(i)]));

  for (const item of items) {
    const linkRows = loadLinks(item.id);
    const links = linkRows
      .map((l) => {
        const name = nameById.get(l.id);
        return name ? { name: name.replace(/\.md$/, ""), type: l.type, weight: l.weight } : null;
      })
      .filter((x): x is { name: string; type: string; weight: number } => x !== null);

    const fileName = nameById.get(item.id)!;
    await fs.writeFile(
      path.join(VAULT_PATH, NOTES_DIR, fileName),
      renderNote(item, loadEntities(item.id), links),
      "utf8"
    );
    index[item.id] = fileName;
  }

  // entity stubs — these are what give Obsidian's graph its hubs
  const entities = db
    .prepare(
      `SELECT e.name, ie.item_id
       FROM entities e JOIN item_entities ie ON ie.entity_id = e.id
       ORDER BY e.name`
    )
    .all() as Array<{ name: string; item_id: string }>;

  const byEntity = new Map<string, Array<{ file: string }>>();
  for (const row of entities) {
    const file = nameById.get(row.item_id);
    if (!file) continue;
    const list = byEntity.get(row.name) || [];
    list.push({ file });
    byEntity.set(row.name, list);
  }

  for (const [name, refs] of byEntity) {
    await fs.writeFile(
      path.join(VAULT_PATH, ENTITIES_DIR, `${safeLinkTarget(name)}.md`),
      renderEntity(name, refs),
      "utf8"
    );
  }

  // sweep files that no longer correspond to anything
  let removed = 0;
  for (const [dir, keep] of [
    [NOTES_DIR, new Set(Object.values(index))],
    [ENTITIES_DIR, new Set([...byEntity.keys()].map((n) => `${safeLinkTarget(n)}.md`))],
  ] as const) {
    const existing = await fs.readdir(path.join(VAULT_PATH, dir)).catch(() => []);
    for (const file of existing) {
      if (file.endsWith(".md") && !keep.has(file)) {
        await fs.rm(path.join(VAULT_PATH, dir, file), { force: true });
        removed++;
      }
    }
  }

  await writeIndex(index);
  return { notes: items.length, entities: byEntity.size, removed };
}

/**
 * Fire-and-forget wrapper used by the write routes.
 *
 * The vault is a mirror, not the record: a full disk or a bad VAULT_PATH must
 * never make saving a note fail. Failures are logged and swallowed.
 */
export async function mirror(
  itemId: string,
  staleNeighbours: string[] = [],
  staleEntities: string[] = []
): Promise<void> {
  try {
    await exportItem(itemId, staleNeighbours, staleEntities);
  } catch (error) {
    console.warn(`[vault] export di ${itemId} fallito:`, error);
  }
}

/** Entity names attached to an item. Capture before a delete, when they still exist. */
export function entityNamesOf(itemId: string): string[] {
  return loadEntities(itemId);
}

export { VAULT_PATH };
