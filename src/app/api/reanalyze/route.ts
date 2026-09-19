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

    const db = await getDb();
    const pendingRs = await db.execute({
      sql: `SELECT id, raw_text, domain_locked FROM items
            WHERE reanalyzed_at IS NULL
            ORDER BY created_at ASC
            LIMIT ?`,
      args: [limit],
    });
    const pending = pendingRs.rows as unknown as PendingItem[];

    const errors: Array<{ id: string; message: string }> = [];
    let processed = 0;

    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      try {
        const parsed = await parseMemory(item.raw_text);

        // domain_locked items keep their domain — a parallel job may have set it deliberately.
        if (item.domain_locked) {
          await db.execute({
            sql: `UPDATE items SET content = ?, type = ?, intent = ?,
                    time_ref = ?, time_confidence = ?, updated_at = datetime('now')
                  WHERE id = ?`,
            args: [
              parsed.summary,
              parsed.type,
              parsed.intent,
              parsed.time.datetime || null,
              parsed.time.confidence,
              item.id,
            ],
          });
        } else {
          await db.execute({
            sql: `UPDATE items SET content = ?, type = ?, domain = ?, intent = ?,
                    time_ref = ?, time_confidence = ?, updated_at = datetime('now')
                  WHERE id = ?`,
            args: [
              parsed.summary,
              parsed.type,
              parsed.domain,
              parsed.intent,
              parsed.time.datetime || null,
              parsed.time.confidence,
              item.id,
            ],
          });
        }

        await syncItemEntities(item.id, parsed.entities, item.raw_text);

        const vector = await embed(parsed.summary || item.raw_text, "passage");
        await saveEmbedding(item.id, "item", vector, EMBED_MODEL);
        await rebuildItemEdges(item.id, vector);

        await db.execute({
          sql: "UPDATE items SET reanalyzed_at = datetime('now') WHERE id = ?",
          args: [item.id],
        });
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

    const remainingRs = await db.execute(
      "SELECT COUNT(*) AS remaining FROM items WHERE reanalyzed_at IS NULL"
    );
    const { remaining } = remainingRs.rows[0] as unknown as { remaining: number };

    return NextResponse.json({ processed, remaining, errors });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
