/**
 * User-editable settings, stored in the `settings` key/value table.
 *
 * Currently one setting: the list of allowed note domains. The parser is told to
 * pick from this list (instead of inventing domains freely, which made the same
 * topic drift between "food" / "cibo" / "cucina" and split the Vault view into
 * near-duplicate folders).
 */
import { getDb } from "./db";

export const FALLBACK_DOMAIN = "general";

export const DEFAULT_DOMAINS = [
  "food",
  "travel",
  "work",
  "health",
  "cinema",
  "tech",
  "music",
  "learning",
  "shopping",
  "finance",
  "pets",
  "relationships",
  FALLBACK_DOMAIN,
];

const MAX_DOMAINS = 40;
const MAX_LENGTH = 24;

/** lowercase, spaces -> "-", strip anything but letters/digits/dash. Empty string if unusable. */
export function normalizeDomain(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH);
}

/** Cleans a user-supplied list: normalised, de-duplicated, capped, fallback always present. */
export function sanitizeDomains(list: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item !== "string") continue;
      const d = normalizeDomain(item);
      if (d && !out.includes(d)) out.push(d);
    }
  }
  const capped = out.filter((d) => d !== FALLBACK_DOMAIN).slice(0, MAX_DOMAINS - 1);
  return [...capped, FALLBACK_DOMAIN];
}

export async function getDomains(): Promise<string[]> {
  try {
    const db = await getDb();
    const rs = await db.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: ["domains"] });
    const raw = rs.rows[0]?.value;
    if (typeof raw === "string") {
      const cleaned = sanitizeDomains(JSON.parse(raw));
      if (cleaned.length > 1) return cleaned;
    }
  } catch {
    // unreadable/corrupt setting -> defaults, never break parsing over it
  }
  return DEFAULT_DOMAINS;
}

export async function setDomains(list: unknown): Promise<string[]> {
  const cleaned = sanitizeDomains(list);
  const db = await getDb();
  await db.execute({
    sql: "INSERT INTO settings (key, value) VALUES ('domains', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    args: [JSON.stringify(cleaned)],
  });
  return cleaned;
}

/** Maps a model-returned domain onto the allowed list; anything unknown becomes the fallback. */
export function matchDomain(candidate: unknown, allowed: string[]): string {
  if (typeof candidate !== "string") return FALLBACK_DOMAIN;
  const d = normalizeDomain(candidate);
  return allowed.includes(d) ? d : FALLBACK_DOMAIN;
}
