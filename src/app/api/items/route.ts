import { NextRequest, NextResponse } from "next/server";
import { getAllItems, deleteItem, getDb, findOrCreateEntity, linkItemEntity, createEdge } from "@/lib/db";
import { parseMemory } from "@/lib/groq";

export async function GET() {
  try {
    const rows = getAllItems() as Array<{
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
      timestamp: new Date(r.created_at).getTime(),
      usageCount: r.usage_count || 0,
      timeRef: r.time_ref,
      timeConfidence: r.time_confidence || 0,
    }));

    return NextResponse.json({ items });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    deleteItem(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const db = getDb();
    db.prepare("UPDATE items SET usage_count = COALESCE(usage_count, 0) + 1 WHERE id = ?").run(id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { id, text } = await req.json();
    if (!id || !text) return NextResponse.json({ error: "id and text required" }, { status: 400 });

    const parsed = await parseMemory(text);
    const db = getDb();

    db.prepare(`
      UPDATE items SET raw_text = ?, content = ?, type = ?, domain = ?, intent = ?,
        time_ref = ?, time_confidence = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(text, parsed.summary, parsed.type, parsed.domain, parsed.intent,
           parsed.time.datetime || null, parsed.time.confidence, id);

    // Remove old entity links and re-link
    db.prepare("DELETE FROM item_entities WHERE item_id = ?").run(id);
    db.prepare("DELETE FROM edges WHERE source_id = ? AND edge_type = 'MENTIONS'").run(id);

    const entityNames: string[] = [];
    for (const ent of parsed.entities) {
      const entityId = findOrCreateEntity(ent.name, ent.type);
      linkItemEntity(id, entityId);
      createEdge({ source_id: id, target_id: entityId, source_type: "item", target_type: "entity", edge_type: "MENTIONS" });
      entityNames.push(ent.name);
    }

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
