/**
 * One-off: copies every row from the local secondbrain.db (better-sqlite3)
 * into the Turso database pointed to by TURSO_DATABASE_URL/TURSO_AUTH_TOKEN
 * in .env.local. Run once, right after the Turso migration, to not lose
 * notes created before the switch. Safe to re-run (idempotent inserts via
 * INSERT OR IGNORE keyed on primary key).
 */
import Database from "better-sqlite3";
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

const envPath = path.join(process.cwd(), ".env.local");
for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const local = new Database(path.join(process.cwd(), "secondbrain.db"), { readonly: true });
const turso = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function copyTable(table, columns) {
  const rows = local.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  if (rows.length === 0) {
    console.log(`${table}: 0 righe, salto`);
    return 0;
  }
  const placeholders = columns.map(() => "?").join(", ");
  const stmts = rows.map((r) => ({
    sql: `INSERT OR IGNORE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    args: columns.map((c) => r[c]),
  }));
  await turso.batch(stmts, "write");
  console.log(`${table}: ${rows.length} righe copiate`);
  return rows.length;
}

// order matters: parents before children (foreign keys)
await copyTable("entities", ["id", "name", "normalized_name", "type", "created_at"]);
await copyTable("items", [
  "id", "content", "raw_text", "type", "domain", "intent", "importance",
  "time_ref", "time_confidence", "usage_count", "reanalyzed_at", "domain_locked",
  "created_at", "updated_at",
]);
await copyTable("item_entities", ["item_id", "entity_id", "confidence"]);
await copyTable("edges", [
  "id", "source_id", "target_id", "source_type", "target_type", "edge_type", "weight", "created_at",
]);
await copyTable("embeddings", ["id", "owner_id", "owner_type", "vector", "model", "dim", "created_at"]);

// FTS5 is populated by triggers on INSERT, but INSERT OR IGNORE via batch
// may not fire them reliably across the remote protocol — force a rebuild.
await turso.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
console.log("FTS5 ricostruito");

const check = await turso.execute("SELECT COUNT(*) AS n FROM items");
console.log(`\nTotale item su Turso ora: ${check.rows[0].n}`);
