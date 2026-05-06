import { NextRequest, NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/groq";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const audio = formData.get("audio") as File | null;
    if (!audio) {
      return NextResponse.json({ error: "audio file is required" }, { status: 400 });
    }
    const buffer = Buffer.from(await audio.arrayBuffer());
    const text = await transcribeAudio(buffer);
    return NextResponse.json({ text });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
