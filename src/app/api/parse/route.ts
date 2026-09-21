import { NextRequest, NextResponse } from "next/server";
import { parseMemory, linkWithLLM } from "@/lib/groq";
import { createItem, syncItemEntities, saveEmbedding } from "@/lib/db";
import { embed, EMBED_MODEL } from "@/lib/embed";
import {
  rebuildItemEdges,
  isReasonedLinkingEnabled,
  saveReasonedEdges,
  type ReasonedType,
} from "@/lib/graph";
import { retrieve } from "@/lib/retrieve";

export async function POST(req: NextRequest) {
  try {
    const { text, force } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const parsed = await parseMemory(text);

    // A question ("explore") gets routed to search instead of becoming a note.
    // `force: "save"` lets the user override that (e.g. "salva comunque come nota").
    // No extra LLM call: this reuses the intent parseMemory already returned above.
    if (parsed.intent === "explore" && force !== "save") {
      return NextResponse.json({ routed: "search", parsed });
    }

    const itemId = await createItem({
      content: parsed.summary,
      raw_text: text,
      type: parsed.type,
      domain: parsed.domain,
      intent: parsed.intent,
      time_ref: parsed.time.datetime || undefined,
      time_confidence: parsed.time.confidence,
    });

    const entityNames = await syncItemEntities(itemId, parsed.entities, text);

    const vector = await embed(parsed.summary || text, "passage");
    await saveEmbedding(itemId, "item", vector, EMBED_MODEL);
    await rebuildItemEdges(itemId, vector);

    // Reasoned linking runs over the shortlist the retrieval already produced —
    // never over the corpus. Opt-in: see isReasonedLinkingEnabled().
    let reasoned = 0;
    if (isReasonedLinkingEnabled()) {
      try {
        const neighbourhood = await retrieve(parsed.summary || text, { excludeId: itemId });
        const links = await linkWithLLM(
          parsed.summary || text,
          neighbourhood.items.map((i) => ({ id: i.id, content: i.content }))
        );
        reasoned = await saveReasonedEdges(
          itemId,
          links.map((l) => ({
            targetId: l.id,
            type: l.type as ReasonedType,
            confidence: l.confidence,
          }))
        );
      } catch {
        // linking is an enhancement; never fail the save because of it
      }
    }

    return NextResponse.json({
      routed: "save",
      reasonedLinks: reasoned,
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
