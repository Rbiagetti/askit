import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, expectedSession, passwordMatches, sessionCookieOptions } from "@/lib/auth";

// Serverless instances share no memory, so a real attempt counter isn't possible
// here; a fixed delay on every failure at least makes guessing slow. Pick a long password.
const FAILURE_DELAY_MS = 700;

export async function POST(req: NextRequest) {
  const expected = await expectedSession();
  if (!expected) {
    return NextResponse.json(
      { error: "ASKIT_PASSWORD non impostata sul server" },
      { status: process.env.NODE_ENV === "production" ? 503 : 200 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const password = typeof body?.password === "string" ? body.password : "";
  if (!(await passwordMatches(password))) {
    await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
    return NextResponse.json({ error: "Password errata" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, expected, sessionCookieOptions(req.nextUrl.protocol === "https:"));
  return res;
}

/** Logout. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
