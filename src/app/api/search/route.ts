import { NextRequest, NextResponse } from "next/server";
import { searchWithLLM } from "@/lib/groq";
import { cosineSimilarity } from "@/lib/vector";
import { getAllItems, getItemVectors } from "@/lib/db";
import { embed, EMBED_MODEL } from "@/lib/embed";

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const allItems = getAllItems() as Array<{
      id: string;
      content: string;
      raw_text: string;
      type: string;
      domain: string;
      entity_list: string | null;
      created_at: string;
    }>;

    if (allItems.length === 0) {
      return NextResponse.json({
        clusters: [],
        response: "Non hai ancora salvato nessuna memoria. Inizia salvando qualcosa!",
      });
    }

    const rankedItems = allItems.map((item) => ({
      ...item,
      entities: item.entity_list || "",
    }));

    // Under 60 items: pass everything to LLM for best recall
    // Over 60: use embedding pre-filtering to narrow down candidates
    let top = rankedItems;
    if (allItems.length > 60) {
      try {
        const queryEmbedding = await embed(query, "query");
        const embMap = new Map(getItemVectors(EMBED_MODEL).map((e) => [e.itemId, e.vector]));
        const scored = rankedItems.map((item) => {
          const vec = embMap.get(item.id);
          const score = vec ? cosineSimilarity(queryEmbedding, vec) : 0;
          return { ...item, score };
        });
        scored.sort((a, b) => b.score - a.score);
        top = scored.slice(0, 40);
      } catch {
        top = rankedItems.slice(0, 40);
      }
    }

    const result = await searchWithLLM(
      query,
      top.map((i) => ({
        id: i.id,
        content: i.content,
        type: i.type,
        domain: i.domain,
        entities: i.entities,
      }))
    );

    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
