import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export async function POST(req: NextRequest) {
  try {
    const { question, memories } = await req.json() as {
      question: string;
      memories: Array<{ id: string; text: string }>;
    };

    if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

    const memoryBlock = memories.length > 0
      ? memories.map((m, i) => `[${i + 1}] ${m.text}`).join("\n")
      : "Nessuna memoria disponibile.";

    const systemPrompt = `Sei un assistente personale di memoria. Hai accesso alle memorie salvate dall'utente.
Rispondi in modo conversazionale e naturale, nella stessa lingua della domanda.
Cita SOLO contenuti presenti nelle memorie — mai inventare o aggiungere informazioni.
Se la risposta non è nelle memorie, dillo chiaramente.
Sii conciso ma utile.`;

    const userPrompt = `Memorie salvate:\n${memoryBlock}\n\nDomanda: ${question}`;

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });

    const response = completion.choices[0]?.message?.content || "Non ho trovato nulla di rilevante.";
    const tokensUsed = (completion.usage?.total_tokens) || 0;

    return NextResponse.json({ response, tokensUsed });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
