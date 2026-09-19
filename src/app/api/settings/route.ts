import { NextRequest, NextResponse } from "next/server";
import { getDomains, setDomains, DEFAULT_DOMAINS } from "@/lib/settings";

export async function GET() {
  try {
    return NextResponse.json({ domains: await getDomains(), defaults: DEFAULT_DOMAINS });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { domains } = await req.json();
    if (!Array.isArray(domains)) {
      return NextResponse.json({ error: "domains must be an array" }, { status: 400 });
    }
    return NextResponse.json({ domains: await setDomains(domains), defaults: DEFAULT_DOMAINS });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
