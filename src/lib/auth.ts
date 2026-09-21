import { NextRequest, NextResponse } from "next/server";

/**
 * Single-password gate for a personal app.
 *
 * `ASKIT_PASSWORD` is the password. After a correct login the browser gets a
 * cookie holding HMAC(password, fixed label): nothing to store server-side, and
 * changing the password invalidates every existing session.
 *
 * Fails closed in production: with no password configured every request is
 * refused (503) rather than silently serving the notes to anyone. In
 * development the gate is off so `npm run dev` keeps working with no setup.
 *
 * Checked in two places on purpose — src/proxy.ts (redirects pages to /login)
 * and inside every route handler (denyIfUnauthed). The route handlers are what
 * actually guard the data; Next's docs advise not to rely on the proxy alone.
 */

export const SESSION_COOKIE = "askit_session";
// A year, renewed on every page visit (see proxy.ts): a personal app on a phone
// shouldn't ask for the password again unless it hasn't been opened for a year.
// Stolen-cookie exposure is the trade-off; changing ASKIT_PASSWORD kills every session.
export const SESSION_MAX_AGE = 60 * 60 * 24 * 365;

export function sessionCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, secure, path: "/", maxAge: SESSION_MAX_AGE };
}

const LABEL = "askit-session-v1";
const encoder = new TextEncoder();

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Value the session cookie must have, or null when no password is configured. */
export async function expectedSession(): Promise<string | null> {
  const password = process.env.ASKIT_PASSWORD;
  return password ? hmacHex(password, LABEL) : null;
}

/** True when `candidate` is the configured password (both sides hashed first, so length doesn't leak). */
export async function passwordMatches(candidate: string): Promise<boolean> {
  const password = process.env.ASKIT_PASSWORD;
  // an empty candidate would make importKey() throw (zero-length HMAC key)
  if (!password || !candidate) return false;
  const [a, b] = await Promise.all([hmacHex(password, LABEL), hmacHex(candidate, LABEL)]);
  return safeEqual(a, b);
}

export type AuthState = "ok" | "unauthenticated" | "unconfigured";

export async function authState(req: NextRequest): Promise<AuthState> {
  const expected = await expectedSession();
  if (!expected) return process.env.NODE_ENV === "production" ? "unconfigured" : "ok";
  const cookie = req.cookies.get(SESSION_COOKIE)?.value;
  return cookie && safeEqual(cookie, expected) ? "ok" : "unauthenticated";
}

/** Route-handler guard: returns the response to send back, or null when the request may proceed. */
export async function denyIfUnauthed(req: NextRequest): Promise<NextResponse | null> {
  const state = await authState(req);
  if (state === "ok") return null;
  if (state === "unconfigured") {
    return NextResponse.json({ error: "ASKIT_PASSWORD non impostata sul server" }, { status: 503 });
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
