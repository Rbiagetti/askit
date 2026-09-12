import { NextRequest, NextResponse } from "next/server";
import { parseMemory } from "@/lib/groq";
import { createItem, syncItemEntities, saveEmbedding } from "@/lib/db";
import { embed, EMBED_MODEL } from "@/lib/embed";

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const parsed = await parseMemory(text);

    const itemId = createItem({
      content: parsed.summary,
      raw_text: text,
      type: parsed.type,
      domain: parsed.domain,
      intent: parsed.intent,
      time_ref: parsed.time.datetime || undefined,
      time_confidence: parsed.time.confidence,
    });

    const entityNames = syncItemEntities(itemId, parsed.entities);

    const vector = await embed(parsed.summary || text, "passage");
    saveEmbedding(itemId, "item", vector, EMBED_MODEL);

    return NextResponse.json({
      id: itemId,
      content: parsed.summary,
      text,
      type: parsed.type,
      domain: parsed.domain,
      entities: entityNames,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
