import { NextRequest, NextResponse } from "next/server";
import { authState } from "@/lib/auth";

// First line of defence: send unauthenticated visitors to /login and refuse API
// calls. The route handlers repeat the check themselves (see lib/auth.ts).
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/login" || pathname === "/api/auth") return NextResponse.next();

  const state = await authState(req);
  if (state === "ok") return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return state === "unconfigured"
      ? NextResponse.json({ error: "ASKIT_PASSWORD non impostata sul server" }, { status: 503 })
      : NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/login", req.url));
}

export const config = {
  // everything except Next's static assets and the app icons
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)"],
};
