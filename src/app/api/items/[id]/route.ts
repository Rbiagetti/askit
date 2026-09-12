import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * Item detail for the Vault UI: the note itself, its entities and — the piece
 * missing everywhere else in the UI — its item↔item graph edges (SIMILAR_TO,
 * CO_OCCURS, DUPLICATES, ...), with the edge type and the partner note's own
 * summary so a caller doesn't need a second round-trip to render a link.
 *
 * Direct queries via getDb(), same pattern as src/lib/retrieve.ts and
 * src/lib/markdown.ts — no new db.ts helpers needed for this.
 */

interface ItemRow {
  id: string;
  content: string;
  raw_text: string;
  type: string;
  domain: string | null;
  domain_locked: number;
  intent: string | null;
  importance: number | null;
  time_ref: string | null;
  time_confidence: number | null;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const db = getDb();
    const row = db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

    const entities = db
      .prepare(
        `SELECT e.name, e.type
         FROM entities e
         JOIN item_entities ie ON ie.entity_id = e.id
         WHERE ie.item_id = ?
         ORDER BY e.name`
      )
      .all(id) as Array<{ name: string; type: string }>;

    // Item↔item edges only — MENTIONS (item→entity) is already covered by `entities` above.
    const edgeRows = db
      .prepare(
        `SELECT id, source_id, target_id, edge_type, weight
         FROM edges
         WHERE source_type = 'item' AND target_type = 'item'
           AND (source_id = ? OR target_id = ?)
         ORDER BY weight DESC`
      )
      .all(id, id) as Array<{
      id: string;
      source_id: string;
      target_id: string;
      edge_type: string;
      weight: number;
    }>;

    const partnerIds = [
      ...new Set(edgeRows.map((e) => (e.source_id === id ? e.target_id : e.source_id))),
    ];
    let partners = new Map<string, { id: string; content: string; type: string; domain: string | null }>();
    if (partnerIds.length > 0) {
      const placeholders = partnerIds.map(() => "?").join(",");
      const partnerRows = db
        .prepare(`SELECT id, content, type, domain FROM items WHERE id IN (${placeholders})`)
        .all(...partnerIds) as Array<{ id: string; content: string; type: string; domain: string | null }>;
      partners = new Map(partnerRows.map((p) => [p.id, p]));
    }

    const edges = edgeRows
      .map((e) => {
        const direction: "out" | "in" = e.source_id === id ? "out" : "in";
        const partnerId = e.source_id === id ? e.target_id : e.source_id;
        const partner = partners.get(partnerId);
        if (!partner) return null; // dangling edge (partner deleted); skip rather than crash the panel
        return {
          id: e.id,
          edgeType: e.edge_type,
          weight: e.weight,
          direction,
          partner: {
            id: partner.id,
            content: partner.content,
            type: partner.type,
            domain: partner.domain,
          },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    return NextResponse.json({
      item: {
        id: row.id,
        content: row.content,
        rawText: row.raw_text,
        type: row.type,
        domain: row.domain,
        domainLocked: !!row.domain_locked,
        intent: row.intent,
        importance: row.importance,
        timeRef: row.time_ref,
        timeConfidence: row.time_confidence,
        usageCount: row.usage_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      entities,
      edges,
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
