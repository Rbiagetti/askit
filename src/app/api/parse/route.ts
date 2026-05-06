import { NextRequest, NextResponse } from "next/server";
import { parseMemory } from "@/lib/groq";
import { createItem, findOrCreateEntity, linkItemEntity, createEdge } from "@/lib/db";

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

    const entityNames: string[] = [];
    for (const ent of parsed.entities) {
      const entityId = findOrCreateEntity(ent.name, ent.type);
      linkItemEntity(itemId, entityId);
      createEdge({
        source_id: itemId, target_id: entityId,
        source_type: "item", target_type: "entity",
        edge_type: "MENTIONS",
      });
      entityNames.push(ent.name);
    }

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
