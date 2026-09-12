/**
 * Regenerates the whole markdown vault from the database.
 *
 *   npm run dev          # in another terminal
 *   npm run vault:export
 *
 * Goes through the running app rather than importing the TypeScript directly,
 * so there is exactly one implementation of the export (src/lib/markdown.ts).
 * Individual notes are mirrored automatically on every write; this is the
 * full rebuild, for after a bulk change or a vault move.
 */
const URL_BASE = process.env.SB_URL || "http://localhost:3000";

let res;
try {
  res = await fetch(`${URL_BASE}/api/vault`, { method: "POST" });
} catch {
  console.error(`Non riesco a raggiungere ${URL_BASE}. Avvia l'app con "npm run dev".`);
  process.exit(1);
}

const body = await res.json();
if (!res.ok) {
  console.error(`Export fallito: ${body.error || res.status}`);
  process.exit(1);
}

console.log(`Vault: ${body.vaultPath}`);
console.log(`  note    : ${body.notes}`);
console.log(`  entità  : ${body.entities}`);
console.log(`  rimossi : ${body.removed}`);
