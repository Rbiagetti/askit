import { NextResponse } from "next/server";
import { getDb, getItemsMissingEmbedding, getItemVectors, saveEmbedding } from "@/lib/db";
import { embedBatch, EMBED_MODEL } from "@/lib/embed";
import { rebuildItemEdges } from "@/lib/graph";

/**
 * Free maintenance pass: zero LLM tokens, safe to expose without confirmation.
 *
 * - backfills missing embeddings (same logic as scripts/backfill-embeddings.mjs,
 *   but reusing lib/embed.ts in-process instead of shelling out to the script)
 * - recomputes CO_OCCURS / SIMILAR_TO for every item (lib/graph.ts)
 * - forces a full FTS5 index rebuild
 */
export async function POST() {
  try {
    const db = await getDb();

    // 1. Backfill embeddings for items that don't have one yet.
    const missing = await getItemsMissingEmbedding(EMBED_MODEL);
    if (missing.length > 0) {
      const vectors = await embedBatch(
        missing.map((item) => item.text),
        "passage"
      );
      for (let i = 0; i < missing.length; i++) {
        await saveEmbedding(missing[i].id, "item", vectors[i], EMBED_MODEL);
      }
    }

    // 2. Recompute item<->item edges for every item that now has a vector.
    const allItemsRs = await db.execute("SELECT id FROM items");
    const allItems = allItemsRs.rows as unknown as Array<{ id: string }>;
    const vectorByItem = new Map(
      (await getItemVectors(EMBED_MODEL)).map((v) => [v.itemId, v.vector])
    );

    let coOccurs = 0;
    let similar = 0;
    for (const item of allItems) {
      const vector = vectorByItem.get(item.id);
      if (!vector) continue; // no vector for this item, skip (e.g. embedding backfill failed)
      const result = await rebuildItemEdges(item.id, vector);
      coOccurs += result.coOccurs;
      similar += result.similar;
    }

    // 3. Force a full FTS5 rebuild.
    let ftsRebuilt = false;
    try {
      await db.execute("INSERT INTO items_fts(items_fts) VALUES('rebuild')");
      ftsRebuilt = true;
    } catch {
      // FTS5 unavailable in this SQLite build — retrieval degrades to the other generators
    }

    return NextResponse.json({
      edgesRebuilt: { coOccurs, similar },
      embeddingsBackfilled: missing.length,
      ftsRebuilt,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
