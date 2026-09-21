import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthed } from "@/lib/auth";
import { getDb } from "@/lib/db";

/**
 * Tree view of the corpus: items grouped by domain, and by entity.
 *
 * No LLM call — plain SQL over items / entities / item_entities. Two other
 * parallel workstreams depend on this exact response shape, so it is not to
 * be changed casually.
 */

interface TreeItem {
  id: string;
  content: string;
  type: string;
  domain: string | null;
  timeRef: string | null;
  createdAt: string;
}

export async function GET(req: NextRequest) {
  const denied = await denyIfUnauthed(req);
  if (denied) return denied;
  try {
    const db = await getDb();

    const itemsRs = await db.execute(
      `SELECT id, content, type, domain, time_ref AS timeRef, created_at AS createdAt
       FROM items
       WHERE archived_at IS NULL
       ORDER BY created_at DESC`
    );
    const items = itemsRs.rows as unknown as TreeItem[];

    // Group by domain, keeping the null ("Senza categoria") bucket only if
    // it actually ends up with items — which it does by construction here,
    // since we only ever create a bucket when an item lands in it.
    const domainOrder: Array<string | null> = [];
    const domainBuckets = new Map<string | null, TreeItem[]>();
    for (const item of items) {
      const key = item.domain ?? null;
      if (!domainBuckets.has(key)) {
        domainBuckets.set(key, []);
        domainOrder.push(key);
      }
      domainBuckets.get(key)!.push(item);
    }

    // Named domains alphabetically first, "Senza categoria" (null) last.
    domainOrder.sort((a, b) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return a.localeCompare(b);
    });

    const domains = domainOrder
      .map((domain) => ({ domain, items: domainBuckets.get(domain)! }))
      .filter((group) => group.domain !== null || group.items.length > 0);

    // Entities, each with the items that mention them.
    const entityRowsRs = await db.execute(
      `SELECT e.id AS entityId, e.name AS name, e.type AS type,
              i.id AS itemId, i.content AS content
       FROM entities e
       JOIN item_entities ie ON ie.entity_id = e.id
       JOIN items i ON i.id = ie.item_id
       WHERE i.archived_at IS NULL
       ORDER BY e.name COLLATE NOCASE, i.created_at DESC`
    );
    const entityRows = entityRowsRs.rows as unknown as Array<{
      entityId: string;
      name: string;
      type: string;
      itemId: string;
      content: string;
    }>;

    const entityBuckets = new Map<
      string,
      { name: string; type: string; items: Array<{ id: string; content: string }> }
    >();
    for (const row of entityRows) {
      if (!entityBuckets.has(row.entityId)) {
        entityBuckets.set(row.entityId, { name: row.name, type: row.type, items: [] });
      }
      entityBuckets.get(row.entityId)!.items.push({ id: row.itemId, content: row.content });
    }

    return NextResponse.json({
      domains,
      entities: Array.from(entityBuckets.values()),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
