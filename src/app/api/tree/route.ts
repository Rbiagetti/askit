import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * PROVISIONAL implementation.
 *
 * A parallel work stream owns GET /api/tree and will land its own version at
 * merge time — this is a minimal, same-contract stand-in so VaultView.tsx can
 * be built and manually tested in this worktree in the meantime. Keep the
 * response shape byte-for-byte identical to the documented contract so the
 * merge is a no-op (either this file gets overwritten by theirs, or it already
 * matches). Do not extend this beyond the contract.
 *
 * Contract:
 * {
 *   "domains": [{ "domain": string | null, "items": [{id, content, type, domain, timeRef, createdAt}] }],
 *   "entities": [{ "name": string, "type": string, "items": [{id, content}] }]
 * }
 */

interface ItemRow {
  id: string;
  content: string;
  type: string;
  domain: string | null;
  time_ref: string | null;
  created_at: string;
}

export async function GET() {
  try {
    const db = getDb();

    const items = db
      .prepare(
        `SELECT id, content, type, domain, time_ref, created_at
         FROM items
         ORDER BY created_at DESC`
      )
      .all() as ItemRow[];

    const domainMap = new Map<string | null, ItemRow[]>();
    for (const item of items) {
      const key = item.domain && item.domain.trim() ? item.domain : null;
      const list = domainMap.get(key) || [];
      list.push(item);
      domainMap.set(key, list);
    }

    const domains = [...domainMap.entries()]
      .sort(([a], [b]) => {
        if (a === null) return 1;
        if (b === null) return -1;
        return a.localeCompare(b);
      })
      .map(([domain, domainItems]) => ({
        domain,
        items: domainItems.map((i) => ({
          id: i.id,
          content: i.content,
          type: i.type,
          domain: i.domain,
          timeRef: i.time_ref,
          createdAt: i.created_at,
        })),
      }));

    const entityRows = db
      .prepare(
        `SELECT e.name AS name, e.type AS type, i.id AS item_id, i.content AS item_content
         FROM entities e
         JOIN item_entities ie ON ie.entity_id = e.id
         JOIN items i ON i.id = ie.item_id
         ORDER BY e.name, i.created_at DESC`
      )
      .all() as Array<{ name: string; type: string; item_id: string; item_content: string }>;

    const entityMap = new Map<
      string,
      { name: string; type: string; items: Array<{ id: string; content: string }> }
    >();
    for (const row of entityRows) {
      const key = `${row.name}::${row.type}`;
      const entry = entityMap.get(key) || { name: row.name, type: row.type, items: [] };
      entry.items.push({ id: row.item_id, content: row.item_content });
      entityMap.set(key, entry);
    }

    const entities = [...entityMap.values()].sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ domains, entities });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
