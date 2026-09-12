/**
 * Generates embeddings for items that don't have one yet.
 *
 * Run after changing the embedding model, or once to populate an existing DB:
 *   npm run embeddings:backfill
 *
 * Safe to re-run: only items missing a vector for the current model are processed.
 */
import Database from "better-sqlite3";
import { pipeline } from "@huggingface/transformers";
import path from "node:path";
import { randomUUID } from "node:crypto";

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const BATCH = 16;

const db = new Database(path.join(process.cwd(), "secondbrain.db"));
db.pragma("journal_mode = WAL");

// Match the schema migration in src/lib/db.ts when running against an older DB
try {
  db.exec("ALTER TABLE embeddings ADD COLUMN dim INTEGER");
} catch {
  // already applied
}

const pending = db
  .prepare(
    `SELECT i.id, COALESCE(i.content, i.raw_text) AS text
     FROM items i
     LEFT JOIN embeddings e
       ON e.owner_id = i.id AND e.owner_type = 'item' AND e.model = ?
     WHERE e.id IS NULL`
  )
  .all(EMBED_MODEL);

if (pending.length === 0) {
  console.log("Nothing to do — every item already has a vector.");
  process.exit(0);
}

console.log(`${pending.length} item(s) without an embedding. Loading ${EMBED_MODEL}...`);
const extract = await pipeline("feature-extraction", EMBED_MODEL);

const insert = db.prepare(
  "INSERT INTO embeddings (id, owner_id, owner_type, vector, model, dim) VALUES (?, ?, 'item', ?, ?, ?)"
);
const clear = db.prepare("DELETE FROM embeddings WHERE owner_id = ? AND owner_type = 'item'");

let done = 0;
for (let i = 0; i < pending.length; i += BATCH) {
  const slice = pending.slice(i, i + BATCH);
  const out = await extract(
    slice.map((r) => `passage: ${r.text.replace(/\s+/g, " ").trim()}`),
    { pooling: "mean", normalize: true }
  );
  const vectors = out.tolist();

  db.transaction(() => {
    slice.forEach((row, j) => {
      clear.run(row.id);
      insert.run(randomUUID(), row.id, JSON.stringify(vectors[j]), EMBED_MODEL, vectors[j].length);
    });
  })();

  done += slice.length;
  console.log(`  ${done}/${pending.length}`);
}

console.log(`Done. ${done} embedding(s) written.`);
