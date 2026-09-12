import { NextRequest, NextResponse } from "next/server";
import { getDb, syncItemEntities, saveEmbedding } from "@/lib/db";
import { parseMemory } from "@/lib/groq";
import { embed, EMBED_MODEL } from "@/lib/embed";
import { rebuildItemEdges } from "@/lib/graph";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Groq free tier allows 30 requests/minute (see PIANO.md §4). One parseMemory
// call per item, spaced out, stays comfortably under that.
const DELAY_MS = 2500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PendingItem {
  id: string;
  raw_text: string;
  domain_locked: number;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const requestedLimit = Number(body?.limit);
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(MAX_LIMIT, Math.floor(requestedLimit))
        : DEFAULT_LIMIT;

    const db = getDb();
    const pending = db
      .prepare(
        `SELECT id, raw_text, domain_locked FROM items
         WHERE reanalyzed_at IS NULL
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit) as PendingItem[];

    const errors: Array<{ id: string; message: string }> = [];
    let processed = 0;

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      try {
        const parsed = await parseMemory(item.raw_text);

        // domain_locked items keep their domain — a parallel job may have set it deliberately.
        if (item.domain_locked) {
          db.prepare(
            `UPDATE items SET content = ?, type = ?, intent = ?,
               time_ref = ?, time_confidence = ?, updated_at = datetime('now')
             WHERE id = ?`
          ).run(
            parsed.summary,
            parsed.type,
            parsed.intent,
            parsed.time.datetime || null,
            parsed.time.confidence,
            item.id
          );
        } else {
          db.prepare(
            `UPDATE items SET content = ?, type = ?, domain = ?, intent = ?,
               time_ref = ?, time_confidence = ?, updated_at = datetime('now')
             WHERE id = ?`
          ).run(
            parsed.summary,
            parsed.type,
            parsed.domain,
            parsed.intent,
            parsed.time.datetime || null,
            parsed.time.confidence,
            item.id
          );
        }

        syncItemEntities(item.id, parsed.entities);

        const vector = await embed(parsed.summary || item.raw_text, "passage");
        saveEmbedding(item.id, "item", vector, EMBED_MODEL);
        rebuildItemEdges(item.id, vector);

        db.prepare("UPDATE items SET reanalyzed_at = datetime('now') WHERE id = ?").run(item.id);
        processed++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Unknown error";
        errors.push({ id: item.id, message });
      }

      // Space out calls to stay under 30 req/min — no need to wait after the last one.
      if (i < pending.length - 1) {
        await sleep(DELAY_MS);
      }
    }

    const { remaining } = db
      .prepare("SELECT COUNT(*) AS remaining FROM items WHERE reanalyzed_at IS NULL")
      .get() as { remaining: number };

    return NextResponse.json({ processed, remaining, errors });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
