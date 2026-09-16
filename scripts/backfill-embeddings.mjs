/**
 * Generates embeddings for items that don't have one yet.
 *
 * Run after changing the embedding model, or once to populate an existing DB:
 *   npm run embeddings:backfill
 *
 * Safe to re-run: only items missing a vector for the current model are processed.
 * Needs GEMINI_API_KEY in .env.local (see PIANO.md §9 for why Gemini, not a
 * local model — this used to run transformers.js/onnxruntime-node locally).
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const envPath = path.join(process.cwd(), ".env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2];
}

const API_KEY = process.env.GEMINI_API_KEY;
if (!API_KEY) {
  console.error("GEMINI_API_KEY mancante in .env.local");
  process.exit(1);
}

const GEMINI_MODEL = "gemini-embedding-001";
const EMBED_DIM = 768;
const EMBED_MODEL = `gemini/${GEMINI_MODEL}@${EMBED_DIM}`;
const BATCH = 16; // Gemini's batchEmbedContents has its own per-request limits; 16 stays well under them

const db = new Database(process.env.SB_DB_PATH || path.join(process.cwd(), "secondbrain.db"));
db.pragma("journal_mode = WAL");

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

async function embedBatch(texts) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${GEMINI_MODEL}`,
          content: { parts: [{ text: t.replace(/\s+/g, " ").trim() }] },
          taskType: "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBED_DIM,
        })),
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

console.log(`${pending.length} item(s) without an embedding. Chiamando Gemini (${GEMINI_MODEL})...`);

const insert = db.prepare(
  "INSERT INTO embeddings (id, owner_id, owner_type, vector, model, dim) VALUES (?, ?, 'item', ?, ?, ?)"
);
const clear = db.prepare("DELETE FROM embeddings WHERE owner_id = ? AND owner_type = 'item'");

let done = 0;
for (let i = 0; i < pending.length; i += BATCH) {
  const slice = pending.slice(i, i + BATCH);
  const vectors = await embedBatch(slice.map((r) => r.text));

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
