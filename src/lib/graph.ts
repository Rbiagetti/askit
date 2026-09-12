/**
 * Builds the item↔item edges that make this an actual graph.
 *
 * Before this module the edges table only ever held item→entity MENTIONS links:
 * a star topology where no note knew about any other note, so there was nothing
 * for graph traversal to traverse. See PIANO.md §1.1.
 *
 * Three layers, cheapest first:
 *   - CO_OCCURS  pure SQL, deterministic, free
 *   - SIMILAR_TO local embeddings, free
 *   - reasoned   LLM, only over already-shortlisted candidates
 */
import { getDb, getItemVectors } from "./db";
import { cosineSimilarity } from "./vector";
import { EMBED_MODEL } from "./embed";

/** Shared-entity edges. Two items linked when they mention ≥2 entities in common. */
export async function linkCoOccurring(itemId: string, minShared = 2): Promise<number> {
  const db = await getDb();
  const rs = await db.execute({
    sql: `SELECT ie2.item_id AS other, COUNT(*) AS shared
          FROM item_entities ie1
          JOIN item_entities ie2
            ON ie1.entity_id = ie2.entity_id AND ie2.item_id != ie1.item_id
          WHERE ie1.item_id = ?
          GROUP BY ie2.item_id
          HAVING shared >= ?`,
    args: [itemId, minShared],
  });
  const partners = rs.rows as unknown as Array<{ other: string; shared: number }>;

  if (partners.length > 0) {
    const statements = partners.map((p) => {
      // one row per unordered pair, so the smaller id is always the source
      const [a, b] = itemId < p.other ? [itemId, p.other] : [p.other, itemId];
      return {
        sql: `INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
              VALUES (?, ?, ?, 'item', 'item', 'CO_OCCURS', ?)
              ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET weight = excluded.weight`,
        args: [`${a}:${b}:CO_OCCURS`, a, b, p.shared],
      };
    });
    await db.batch(statements, "write");
  }

  return partners.length;
}

/** Minimum corpus size for the z-score statistics below to mean anything. */
const MIN_CORPUS_FOR_SIMILARITY = 5;

/**
 * Semantic neighbour edges, using an ADAPTIVE threshold.
 *
 * A fixed cutoff does not work here: measured over 45 pairs, multilingual-e5-small
 * puts every similarity in [0.808, 0.920] (mean 0.871, sd 0.025) — even for totally
 * unrelated texts. A 0.75 threshold would link everything to everything.
 * So we standardise against this item's own similarity distribution and keep
 * only genuine outliers. See PIANO.md Fase 3b.
 */
export async function linkSimilar(
  itemId: string,
  vector: number[],
  topK = 3,
  minZ = 1.5
): Promise<number> {
  const db = await getDb();
  const allVectors = await getItemVectors(EMBED_MODEL);
  const others = allVectors.filter((v) => v.itemId !== itemId);
  if (others.length < MIN_CORPUS_FOR_SIMILARITY) return 0;

  const scored = others.map((o) => ({
    itemId: o.itemId,
    score: cosineSimilarity(vector, o.vector),
  }));

  const mean = scored.reduce((a, s) => a + s.score, 0) / scored.length;
  const sd = Math.sqrt(
    scored.reduce((a, s) => a + (s.score - mean) ** 2, 0) / scored.length
  );
  if (sd === 0) return 0;

  const winners = scored
    .map((s) => ({ ...s, z: (s.score - mean) / sd }))
    .filter((s) => s.z >= minZ)
    .sort((a, b) => b.z - a.z)
    .slice(0, topK);

  if (winners.length > 0) {
    const statements = winners.map((w) => {
      const [a, b] = itemId < w.itemId ? [itemId, w.itemId] : [w.itemId, itemId];
      return {
        sql: `INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
              VALUES (?, ?, ?, 'item', 'item', 'SIMILAR_TO', ?)
              ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET weight = excluded.weight`,
        args: [`${a}:${b}:SIMILAR_TO`, a, b, Number(w.score.toFixed(4))],
      };
    });
    await db.batch(statements, "write");
  }

  return winners.length;
}

/** Removes the derived item↔item edges of an item, before recomputing them. */
export async function clearDerivedEdges(itemId: string): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `DELETE FROM edges
          WHERE edge_type IN ('CO_OCCURS', 'SIMILAR_TO')
            AND (source_id = ? OR target_id = ?)`,
    args: [itemId, itemId],
  });
}

/** Recomputes every derived edge for an item. Called after each write. */
export async function rebuildItemEdges(
  itemId: string,
  vector: number[]
): Promise<{ coOccurs: number; similar: number }> {
  await clearDerivedEdges(itemId);
  const coOccurs = await linkCoOccurring(itemId);
  const similar = await linkSimilar(itemId, vector);
  return { coOccurs, similar };
}

/** Relation types the model may assign. Anything else is discarded. */
const REASONED_TYPES = ["RELATES_TO", "CONTINUES", "CONTRADICTS", "DUPLICATES"] as const;
export type ReasonedType = (typeof REASONED_TYPES)[number];

export interface ReasonedEdge {
  targetId: string;
  type: ReasonedType;
  confidence: number;
}

/**
 * Opt-in: the only place in the system where a model reasons about graph structure.
 *
 * OFF by default because of the free tier's 1000 output-tokens-per-minute ceiling —
 * reasoning tokens count towards it, and parsing a note already reserves 500. Enable
 * with SB_REASONED_LINKING=1 when the extra relation types are worth the budget.
 * CO_OCCURS and SIMILAR_TO already produce a usable graph at zero cost.
 *
 * Runs strictly over candidates already shortlisted by retrieve() — never the corpus.
 */
export function isReasonedLinkingEnabled(): boolean {
  return process.env.SB_REASONED_LINKING === "1";
}

export async function saveReasonedEdges(
  itemId: string,
  edges: ReasonedEdge[]
): Promise<number> {
  const db = await getDb();
  const valid = edges.filter((e) => REASONED_TYPES.includes(e.type) && e.targetId !== itemId);
  if (valid.length === 0) return 0;

  const statements = valid.map((e) => {
    const [a, b] = itemId < e.targetId ? [itemId, e.targetId] : [e.targetId, itemId];
    return {
      sql: `INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
            VALUES (?, ?, ?, 'item', 'item', ?, ?)
            ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET weight = excluded.weight`,
      args: [`${a}:${b}:${e.type}`, a, b, e.type, e.confidence],
    };
  });
  await db.batch(statements, "write");
  return valid.length;
}
