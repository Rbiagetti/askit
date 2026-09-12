import { NextResponse } from "next/server";
import { exportAll, VAULT_PATH } from "@/lib/markdown";

/** Regenerates the whole markdown mirror. Incremental exports happen on each write. */
export async function POST() {
  try {
    const result = await exportAll();
    return NextResponse.json({ ...result, vaultPath: VAULT_PATH });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
