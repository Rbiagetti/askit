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
export function linkCoOccurring(itemId: string, minShared = 2): number {
  const db = getDb();
  const partners = db
    .prepare(
      `SELECT ie2.item_id AS other, COUNT(*) AS shared
       FROM item_entities ie1
       JOIN item_entities ie2
         ON ie1.entity_id = ie2.entity_id AND ie2.item_id != ie1.item_id
       WHERE ie1.item_id = ?
       GROUP BY ie2.item_id
       HAVING shared >= ?`
    )
    .all(itemId, minShared) as Array<{ other: string; shared: number }>;

  const upsert = db.prepare(
    `INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
     VALUES (?, ?, ?, 'item', 'item', 'CO_OCCURS', ?)
     ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET weight = excluded.weight`
  );

  db.transaction(() => {
    for (const p of partners) {
      // one row per unordered pair, so the smaller id is always the source
      const [a, b] = itemId < p.other ? [itemId, p.other] : [p.other, itemId];
      upsert.run(`${a}:${b}:CO_OCCURS`, a, b, p.shared);
    }
  })();

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
export function linkSimilar(itemId: string, vector: number[], topK = 3, minZ = 1.5): number {
  const db = getDb();
  const others = getItemVectors(EMBED_MODEL).filter((v) => v.itemId !== itemId);
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

  const upsert = db.prepare(
    `INSERT INTO edges (id, source_id, target_id, source_type, target_type, edge_type, weight)
     VALUES (?, ?, ?, 'item', 'item', 'SIMILAR_TO', ?)
     ON CONFLICT(source_id, target_id, edge_type) DO UPDATE SET weight = excluded.weight`
  );

  db.transaction(() => {
    for (const w of winners) {
      const [a, b] = itemId < w.itemId ? [itemId, w.itemId] : [w.itemId, itemId];
      upsert.run(`${a}:${b}:SIMILAR_TO`, a, b, Number(w.score.toFixed(4)));
    }
  })();

  return winners.length;
}

/** Removes the derived item↔item edges of an item, before recomputing them. */
export function clearDerivedEdges(itemId: string) {
  getDb()
    .prepare(
      `DELETE FROM edges
       WHERE edge_type IN ('CO_OCCURS', 'SIMILAR_TO')
         AND (source_id = ? OR target_id = ?)`
    )
    .run(itemId, itemId);
}

/** Recomputes every derived edge for an item. Called after each write. */
export function rebuildItemEdges(itemId: string, vector: number[]) {
  clearDerivedEdges(itemId);
  const coOccurs = linkCoOccurring(itemId);
  const similar = linkSimilar(itemId, vector);
  return { coOccurs, similar };
}
