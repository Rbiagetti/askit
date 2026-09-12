/**
 * Fills a THROWAWAY database with synthetic Italian notes, to check that retrieval
 * cost stays flat as the corpus grows (PIANO.md Fase 4, acceptance criterion).
 *
 *   SB_DB_PATH=/tmp/bench.db node scripts/seed-synthetic.mjs 200
 *
 * Refuses to touch secondbrain.db. Entities are extracted by a crude heuristic
 * (capitalised words) rather than the LLM — the point is graph shape and volume,
 * not parse quality, and 200 LLM calls would blow the free tier.
 */
import Database from "better-sqlite3";
import { pipeline } from "@huggingface/transformers";
import { randomUUID } from "node:crypto";

const EMBED_MODEL = "Xenova/multilingual-e5-small";
const DB_PATH = process.env.SB_DB_PATH;
const COUNT = Number(process.argv[2] || 200);

if (!DB_PATH || DB_PATH.endsWith("secondbrain.db")) {
  console.error("Set SB_DB_PATH to a throwaway database (not secondbrain.db).");
  process.exit(1);
}

const PEOPLE = ["Emma", "Marco", "Giulia", "Luca", "Sofia", "Andrea", "Chiara", "Matteo"];
const PLACES = ["Lisbona", "Bologna", "Puntala", "Umbria", "Berlino", "Napoli", "Trieste"];
const FILMS = ["Interstellar", "Inception", "Dune", "Oppenheimer", "Perfect Days", "Anatomia"];
const FOODS = ["carbonara", "polpette", "ramen", "tiramisu", "pizza", "risotto", "focaccia"];
const TOPICS = ["Rust", "SQLite", "Kubernetes", "Figma", "Postgres", "Svelte"];

const TEMPLATES = [
  (r) => [`Vedere ${r(FILMS)} con ${r(PEOPLE)} nel weekend`, "wishlist", "cinema"],
  (r) => [`Ho adorato ${r(FILMS)}, da riguardare`, "note", "cinema"],
  (r) => [`Comprare ingredienti per ${r(FOODS)} con ${r(PEOPLE)}`, "task", "food"],
  (r) => [`La ricetta della ${r(FOODS)} secondo ${r(PEOPLE)}`, "note", "food"],
  (r) => [`Weekend a ${r(PLACES)} con ${r(PEOPLE)}, cercare voli`, "idea", "travel"],
  (r) => [`Prenotare hotel a ${r(PLACES)} per il ponte`, "task", "travel"],
  (r) => [`Studiare ${r(TOPICS)}, capire le basi`, "idea", "learning"],
  (r) => [`Riunione su ${r(TOPICS)} con ${r(PEOPLE)} lunedi`, "reminder", "work"],
  (r) => [`Chiamare ${r(PEOPLE)} per il progetto ${r(TOPICS)}`, "reminder", "work"],
  (r) => [`Palestra tre volte a settimana, iniziare con ${r(PEOPLE)}`, "task", "health"],
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const rows = [];
for (let i = 0; i < COUNT; i++) {
  const [text, type, domain] = pick(TEMPLATES)(pick);
  rows.push({ id: randomUUID(), text: `${text} (#${i})`, type, domain });
}

console.log(`Embedding ${rows.length} synthetic notes...`);
const extract = await pipeline("feature-extraction", EMBED_MODEL);
const vectors = [];
for (let i = 0; i < rows.length; i += 32) {
  const slice = rows.slice(i, i + 32);
  const out = await extract(slice.map((r) => `passage: ${r.text}`), {
    pooling: "mean",
    normalize: true,
  });
  vectors.push(...out.tolist());
}

const insItem = db.prepare(
  `INSERT INTO items (id, content, raw_text, type, domain, intent, importance)
   VALUES (?, ?, ?, ?, ?, 'save', 0.5)`
);
const insEmb = db.prepare(
  `INSERT INTO embeddings (id, owner_id, owner_type, vector, model, dim)
   VALUES (?, ?, 'item', ?, ?, ?)`
);
const findEnt = db.prepare("SELECT id FROM entities WHERE normalized_name = ? AND type = ?");
const insEnt = db.prepare(
  "INSERT INTO entities (id, name, normalized_name, type) VALUES (?, ?, ?, ?)"
);
const insLink = db.prepare(
  "INSERT OR IGNORE INTO item_entities (item_id, entity_id, confidence) VALUES (?, ?, 1.0)"
);
const insEdge = db.prepare(
  `INSERT OR IGNORE INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
   VALUES (?, ?, ?, 'item', 'entity', 'MENTIONS', 1.0)`
);

const entityType = (name) =>
  PEOPLE.includes(name) ? "person" : PLACES.includes(name) ? "place" : FILMS.includes(name) ? "movie" : "concept";

db.transaction(() => {
  rows.forEach((row, i) => {
    insItem.run(row.id, row.text, row.text, row.type, row.domain);
    insEmb.run(randomUUID(), row.id, JSON.stringify(vectors[i]), EMBED_MODEL, vectors[i].length);

    const names = [...PEOPLE, ...PLACES, ...FILMS, ...TOPICS].filter((n) => row.text.includes(n));
    for (const name of names) {
      const norm = name.toLowerCase();
      const t = entityType(name);
      let ent = findEnt.get(norm, t);
      if (!ent) {
        const id = randomUUID();
        insEnt.run(id, name, norm, t);
        ent = { id };
      }
      insLink.run(row.id, ent.id);
      insEdge.run(`${row.id}:${ent.id}:MENTIONS`, row.id, ent.id);
    }
  });
})();

db.exec("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
console.log(`Inserted ${rows.length}. Corpus is now ${db.prepare("SELECT COUNT(*) n FROM items").get().n}.`);
