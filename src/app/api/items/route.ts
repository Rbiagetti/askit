import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthed } from "@/lib/auth";
import { getAllItems, deleteItem, getDb, syncItemEntities, saveEmbedding } from "@/lib/db";
import { parseMemory } from "@/lib/groq";
import { embed, EMBED_MODEL } from "@/lib/embed";
import { rebuildItemEdges } from "@/lib/graph";
import { parseDbDate } from "@/lib/dates";

export async function GET(req: NextRequest) {
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const rows = (await getAllItems()) as unknown as Array<{
      id: string;
      content: string;
      raw_text: string;
      type: string;
      domain: string;
      time_ref: string | null;
      time_confidence: number | null;
      created_at: string;
      entity_list: string | null;
      usage_count: number;
      archived_at: string | null;
    }>;

    const items = rows.map((r) => ({
      id: r.id,
      content: r.content,
      text: r.raw_text,
      type: r.type,
      domain: r.domain,
      entities: r.entity_list
        ? r.entity_list.split(",").map((e) => e.split("::")[0]).filter(Boolean)
        : [],
      timestamp: parseDbDate(r.created_at).getTime(),
      usageCount: r.usage_count || 0,
      timeRef: r.time_ref,
      timeConfidence: r.time_confidence || 0,
      archivedAt: r.archived_at ? parseDbDate(r.archived_at).getTime() : null,
    }));

    return NextResponse.json({ items });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    await deleteItem(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const { id, domain, archived } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const db = await getDb();

    // Soft archive / restore. Unlike DELETE this keeps the note, its entities,
    // embedding and edges; retrieve.ts and /api/tree just skip archived rows.
    if (typeof archived === "boolean") {
      await db.execute({
        sql: `UPDATE items SET archived_at = ${archived ? "datetime('now')" : "NULL"} WHERE id = ?`,
        args: [id],
      });
      return NextResponse.json({ ok: true, archived });
    }

    // Manual metadata override: does NOT re-run the LLM parse, unlike PUT above.
    // Sets domain_locked=1 so a future re-parse (out of scope here) knows to leave
    // this item's domain alone instead of overwriting it.
    if (typeof domain === "string") {
      const trimmed = domain.trim();
      if (!trimmed) return NextResponse.json({ error: "domain non può essere vuoto" }, { status: 400 });
      await db.execute({
        sql: "UPDATE items SET domain = ?, domain_locked = 1, updated_at = datetime('now') WHERE id = ?",
        args: [trimmed, id],
      });
      return NextResponse.json({ ok: true, domain: trimmed, domainLocked: true });
    }

    // Default behaviour, unchanged: {id} alone just bumps usage_count.
    await db.execute({
      sql: "UPDATE items SET usage_count = COALESCE(usage_count, 0) + 1 WHERE id = ?",
      args: [id],
    });
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const { id, text } = await req.json();
    if (!id || !text) return NextResponse.json({ error: "id and text required" }, { status: 400 });

    const parsed = await parseMemory(text);
    const db = await getDb();

    await db.execute({
      sql: `
        UPDATE items SET raw_text = ?, content = ?, type = ?, domain = ?, intent = ?,
          time_ref = ?, time_confidence = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
      args: [
        text,
        parsed.summary,
        parsed.type,
        parsed.domain,
        parsed.intent,
        parsed.time.datetime || null,
        parsed.time.confidence,
        id,
      ],
    });

    const entityNames = await syncItemEntities(id, parsed.entities, text);

    // the text changed, so both the stored vector and the derived edges are stale
    const vector = await embed(parsed.summary || text, "passage");
    await saveEmbedding(id, "item", vector, EMBED_MODEL);
    await rebuildItemEdges(id, vector);

    return NextResponse.json({
      id, content: parsed.summary, text,
      type: parsed.type, domain: parsed.domain, entities: entityNames,
      timeRef: parsed.time.datetime || null,
      timeConfidence: parsed.time.confidence,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
