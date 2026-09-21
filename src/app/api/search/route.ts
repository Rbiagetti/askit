import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthed } from "@/lib/auth";
import { searchWithLLM } from "@/lib/groq";
import { retrieve } from "@/lib/retrieve";

export async function POST(req: NextRequest) {
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const { query, dryRun } = await req.json();
    if (!query || typeof query !== "string") {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    // Graph-constrained retrieval, always — regardless of corpus size.
    // This route used to send the whole corpus to the LLM below 60 items, and
    // above that fall back to "the 40 most recent" because the embedding
    // pre-filter was never populated. See PIANO.md §1.3.
    const result = await retrieve(query);

    // Diagnostics: exercise retrieval without spending LLM quota
    if (dryRun) {
      return NextResponse.json({
        retrieval: {
          sent: result.items.length,
          corpusSize: result.corpusSize,
          tokenEstimate: result.tokenEstimate,
          sources: result.sources,
        },
        items: result.items.map((i) => ({
          content: i.content,
          score: Number(i.score.toFixed(5)),
          provenance: i.provenance,
        })),
      });
    }

    if (result.items.length === 0) {
      return NextResponse.json({
        clusters: [],
        response:
          result.corpusSize === 0
            ? "Non hai ancora salvato nessuna memoria. Inizia salvando qualcosa!"
            : "Non ho trovato memorie rilevanti per questa ricerca.",
        retrieval: { sent: 0, corpusSize: result.corpusSize },
      });
    }

    const llm = await searchWithLLM(
      query,
      result.items.map((i) => ({
        id: i.id,
        content: i.content,
        type: i.type,
        domain: i.domain || "",
        entities: i.entities,
        timeRef: i.timeRef,
      }))
    );

    return NextResponse.json({
      ...llm,
      retrieval: {
        sent: result.items.length,
        corpusSize: result.corpusSize,
        tokenEstimate: result.tokenEstimate,
        sources: result.sources,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
