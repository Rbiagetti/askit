import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthed } from "@/lib/auth";
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
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const { text } = await req.json();
    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const parsed = await parseMemory(text);

    // Adding always saves. It used to re-route anything the model called a
    // question ("explore") to search, which swallowed plain notes like
    // "prova askit" (10/10 times). Where the user is decides what they want:
    // Aggiungi saves, Cerca asks.

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
