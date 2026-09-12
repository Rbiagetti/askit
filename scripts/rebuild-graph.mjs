/**
 * Rebuilds every derived item↔item edge (CO_OCCURS, SIMILAR_TO) from scratch.
 *
 *   npm run graph:rebuild
 *
 * Run once after Fase 3, and any time the embedding model changes.
 * MENTIONS edges are owned by the parser and are left untouched.
 */
import Database from "better-sqlite3";
import path from "node:path";

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const MIN_SHARED_ENTITIES = 2;
const MIN_CORPUS_FOR_SIMILARITY = 5;
const TOP_K = 3;
const MIN_Z = 1.5;

const db = new Database(process.env.SB_DB_PATH || path.join(process.cwd(), "secondbrain.db"));
db.pragma("journal_mode = WAL");

db.exec(`DELETE FROM edges WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM edges GROUP BY source_id, target_id, edge_type)`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON edges(source_id, target_id, edge_type)`);
db.exec("DELETE FROM edges WHERE edge_type IN ('CO_OCCURS','SIMILAR_TO')");

const cos = (a, b) => {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) d += a[i] * b[i];
  return d;
};

const insert = db.prepare(
  `INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
   VALUES (?, ?, ?, 'item', 'item', ?, ?)
   ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET weight = excluded.weight`
);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);

// --- CO_OCCURS -------------------------------------------------------------
const coPairs = db
  .prepare(
    `SELECT ie1.item_id AS a, ie2.item_id AS b, COUNT(*) AS shared
     FROM item_entities ie1
     JOIN item_entities ie2 ON ie1.entity_id = ie2.entity_id AND ie1.item_id < ie2.item_id
     GROUP BY ie1.item_id, ie2.item_id
     HAVING shared >= ?`
  )
  .all(MIN_SHARED_ENTITIES);

db.transaction(() => {
  for (const p of coPairs) insert.run(`${p.a}:${p.b}:CO_OCCURS`, p.a, p.b, "CO_OCCURS", p.shared);
})();
console.log(`CO_OCCURS : ${coPairs.length}`);

// --- SIMILAR_TO ------------------------------------------------------------
const vectors = db
  .prepare("SELECT owner_id, vector FROM embeddings WHERE owner_type='item' AND model=?")
  .all(EMBED_MODEL)
  .map((r) => ({ id: r.owner_id, v: JSON.parse(r.vector) }));

let simCount = 0;
if (vectors.length >= MIN_CORPUS_FOR_SIMILARITY + 1) {
  db.transaction(() => {
    for (const self of vectors) {
      const scored = vectors.filter((o) => o.id !== self.id).map((o) => ({ id: o.id, s: cos(self.v, o.v) }));
      const mean = scored.reduce((a, x) => a + x.s, 0) / scored.length;
      const sd = Math.sqrt(scored.reduce((a, x) => a + (x.s - mean) ** 2, 0) / scored.length);
      if (sd === 0) continue;
      const winners = scored
        .map((x) => ({ ...x, z: (x.s - mean) / sd }))
        .filter((x) => x.z >= MIN_Z)
        .sort((a, b) => b.z - a.z)
        .slice(0, TOP_K);
      for (const w of winners) {
        const [a, b] = pair(self.id, w.id);
        insert.run(`${a}:${b}:SIMILAR_TO`, a, b, "SIMILAR_TO", Number(w.s.toFixed(4)));
        simCount++;
      }
    }
  })();
} else {
  console.log(`(corpus troppo piccolo per SIMILAR_TO: ${vectors.length} vettori)`);
}
console.log(`SIMILAR_TO: ${simCount} (con duplicati simmetrici collassati dall'upsert)`);

console.log("\nArchi per tipo:");
for (const r of db.prepare("SELECT edge_type, COUNT(*) n FROM edges GROUP BY edge_type").all())
  console.log(`  ${r.edge_type.padEnd(12)} ${r.n}`);
