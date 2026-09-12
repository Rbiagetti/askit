/**
 * Graph-constrained retrieval.
 *
 * The point of the whole refactor: what gets sent to the LLM is the relevant
 * NEIGHBOURHOOD, never the whole corpus. Cost per operation then scales with
 * local density (bounded) instead of corpus size (unbounded).
 *
 * Four candidate generators, all running locally in SQL at zero token cost,
 * fused by Reciprocal Rank Fusion and truncated. Only the survivors reach the model.
 * See PIANO.md §2.2.
 */
import { getDb, getItemVectors } from "./db";
import { cosineSimilarity } from "./vector";
import { embed, EMBED_MODEL } from "./embed";

export type Source = "anchor" | "graph" | "vector" | "fts";

export interface RetrievedItem {
  id: string;
  content: string;
  raw_text: string;
  type: string;
  domain: string | null;
  entities: string;
  created_at: string;
  timeRef: string | null;
  score: number;
  /** Which generators found this item, and at what rank. Useful when a result surprises. */
  provenance: Partial<Record<Source, number>>;
}

export interface RetrievalResult {
  items: RetrievedItem[];
  tokenEstimate: number;
  sources: Record<Source, number>;
  corpusSize: number;
}

/** RRF damping constant. 60 is the value from the original paper; not tuned here. */
const RRF_K = 60;
const DEFAULT_LIMIT = 12;
/** How many candidates each generator may contribute before fusion. */
const PER_SOURCE_LIMIT = 20;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * ① Entity anchors — highest precision. If the input names "Interstellar",
 * notes about Interstellar are relevant with certainty, no semantic guesswork.
 */
function findAnchors(input: string, excludeId?: string): string[] {
  const db = getDb();
  const haystack = ` ${normalize(input)} `;
  const entities = db.prepare("SELECT id, normalized_name FROM entities").all() as Array<{
    id: string;
    normalized_name: string;
  }>;

  const hits = entities
    .filter((e) => {
      const needle = normalize(e.normalized_name).trim();
      // word-boundary match, so "mar" doesn't match "Marco"
      return needle.length > 2 && new RegExp(`(^|\\W)${escapeRegex(needle)}(\\W|$)`).test(haystack);
    })
    .map((e) => e.id);

  if (hits.length === 0) return [];

  const placeholders = hits.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT ie.item_id, COUNT(*) AS matches
       FROM item_entities ie
       WHERE ie.entity_id IN (${placeholders})
       GROUP BY ie.item_id
       ORDER BY matches DESC
       LIMIT ${PER_SOURCE_LIMIT}`
    )
    .all(...hits) as Array<{ item_id: string; matches: number }>;

  return rows.map((r) => r.item_id).filter((id) => id !== excludeId);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ② Graph expansion — the reason a graph exists. Reaches notes that share neither
 * words nor entities with the input, but sit one hop from something that does.
 */
function expandNeighborhood(seedIds: string[], hops: 1 | 2, excludeId?: string): string[] {
  if (seedIds.length === 0) return [];
  const db = getDb();

  const scores = new Map<string, number>();
  let frontier = seedIds;
  const seen = new Set(seedIds);

  for (let hop = 1; hop <= hops; hop++) {
    if (frontier.length === 0) break;
    const placeholders = frontier.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT CASE WHEN source_id IN (${placeholders}) THEN target_id ELSE source_id END AS neighbour,
                MAX(weight) AS weight
         FROM edges
         WHERE source_type = 'item' AND target_type = 'item'
           AND (source_id IN (${placeholders}) OR target_id IN (${placeholders}))
         GROUP BY neighbour`
      )
      .all(...frontier, ...frontier, ...frontier) as Array<{
      neighbour: string;
      weight: number;
    }>;

    const next: string[] = [];
    for (const r of rows) {
      if (seen.has(r.neighbour) || r.neighbour === excludeId) continue;
      seen.add(r.neighbour);
      next.push(r.neighbour);
      // distance penalty: a 2-hop neighbour counts for half
      scores.set(r.neighbour, (r.weight || 1) / hop);
    }
    frontier = next;
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PER_SOURCE_LIMIT)
    .map(([id]) => id);
}

/** ③ Vector kNN — covers paraphrase, where wording differs but meaning matches. */
async function vectorNeighbors(input: string, excludeId?: string): Promise<string[]> {
  const vectors = getItemVectors(EMBED_MODEL).filter((v) => v.itemId !== excludeId);
  if (vectors.length === 0) return [];
  const queryVec = await embed(input, "query");
  return vectors
    .map((v) => ({ id: v.itemId, score: cosineSimilarity(queryVec, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, PER_SOURCE_LIMIT)
    .map((v) => v.id);
}

/** ④ FTS5 — the opposite failure mode of embeddings: rare terms, names, numbers. */
function lexicalMatches(input: string, excludeId?: string): string[] {
  const db = getDb();
  const terms = normalize(input)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return [];

  // quote every term so FTS5 operators in user input can't break the query
  const match = terms.map((t) => `"${t}"`).join(" OR ");
  try {
    const rows = db
      .prepare(
        `SELECT i.id
         FROM items_fts f
         JOIN items i ON i.rowid = f.rowid
         WHERE items_fts MATCH ?
         ORDER BY bm25(items_fts)
         LIMIT ${PER_SOURCE_LIMIT}`
      )
      .all(match) as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => id !== excludeId);
  } catch {
    return []; // FTS unavailable; the other three generators still work
  }
}

/** Reciprocal Rank Fusion: combines rankings whose score scales aren't comparable. */
function fuse(lists: Array<{ source: Source; ids: string[] }>) {
  const acc = new Map<string, { score: number; provenance: Partial<Record<Source, number>> }>();
  for (const { source, ids } of lists) {
    ids.forEach((id, index) => {
      const rank = index + 1;
      const entry = acc.get(id) || { score: 0, provenance: {} };
      entry.score += 1 / (RRF_K + rank);
      entry.provenance[source] = rank;
      acc.set(id, entry);
    });
  }
  return [...acc.entries()].sort((a, b) => b[1].score - a[1].score);
}

export async function retrieve(
  input: string,
  opts: { limit?: number; hops?: 1 | 2; excludeId?: string } = {}
): Promise<RetrievalResult> {
  const { limit = DEFAULT_LIMIT, hops = 2, excludeId } = opts;
  const db = getDb();

  const anchors = findAnchors(input, excludeId);
  const graph = expandNeighborhood(anchors, hops, excludeId);
  const [vector, fts] = [await vectorNeighbors(input, excludeId), lexicalMatches(input, excludeId)];

  const ranked = fuse([
    { source: "anchor", ids: anchors },
    { source: "graph", ids: graph },
    { source: "vector", ids: vector },
    { source: "fts", ids: fts },
  ]).slice(0, limit);

  const corpusSize = (db.prepare("SELECT COUNT(*) AS n FROM items").get() as { n: number }).n;
  if (ranked.length === 0) {
    return {
      items: [],
      tokenEstimate: 0,
      sources: { anchor: 0, graph: 0, vector: 0, fts: 0 },
      corpusSize,
    };
  }

  const placeholders = ranked.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT i.id, i.content, i.raw_text, i.type, i.domain, i.created_at, i.time_ref,
              GROUP_CONCAT(DISTINCT e.name) AS entity_list
       FROM items i
       LEFT JOIN item_entities ie ON i.id = ie.item_id
       LEFT JOIN entities e ON ie.entity_id = e.id
       WHERE i.id IN (${placeholders})
       GROUP BY i.id`
    )
    .all(...ranked.map(([id]) => id)) as Array<{
    id: string;
    content: string;
    raw_text: string;
    type: string;
    domain: string | null;
    created_at: string;
    time_ref: string | null;
    entity_list: string | null;
  }>;

  const byId = new Map(rows.map((r) => [r.id, r]));
  const items: RetrievedItem[] = ranked
    .map(([id, meta]) => {
      const row = byId.get(id);
      if (!row) return null;
      return {
        id: row.id,
        content: row.content,
        raw_text: row.raw_text,
        type: row.type,
        domain: row.domain,
        entities: row.entity_list || "",
        created_at: row.created_at,
        timeRef: row.time_ref,
        score: meta.score,
        provenance: meta.provenance,
      };
    })
    .filter((x): x is RetrievedItem => x !== null);

  return {
    items,
    // ~4 chars per token, close enough to track the budget
    tokenEstimate: Math.ceil(
      items.reduce((a, i) => a + i.content.length + i.entities.length + 30, 0) / 4
    ),
    sources: {
      anchor: anchors.length,
      graph: graph.length,
      vector: vector.length,
      fts: fts.length,
    },
    corpusSize,
  };
}
