import Groq from "groq-sdk";

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export interface ParsedMemory {
  type: "note" | "task" | "wishlist" | "idea" | "reminder";
  domain: string;
  entities: Array<{ name: string; type: "place" | "movie" | "concept" | "person" }>;
  intent: "save" | "remind" | "explore";
  time: { datetime: string | null; confidence: number };
  summary: string;
}

const PARSE_SYSTEM = `You are a memory parser for a personal knowledge system. Given user input in any language, extract structured data.

Respond ONLY with valid JSON matching this schema:
{
  "type": "note" | "task" | "wishlist" | "idea" | "reminder",
  "domain": "string (e.g. food, travel, work, cinema, music, tech, health, relationships, finance, learning)",
  "entities": [{"name": "string", "type": "place" | "movie" | "concept" | "person"}],
  "intent": "save" | "remind" | "explore",
  "time": {"datetime": "ISO8601 or null", "confidence": 0.0-1.0},
  "summary": "brief clean summary of the memory in the same language as input"
}

Rules:
- Always extract entities when present
- Infer domain from context
- If temporal references exist, convert to ISO8601 (assume current year 2026, current date context)
- Keep summary concise and in the original language
- If unsure about type, default to "note"
- Never add entities that aren't clearly referenced`;

export async function parseMemory(text: string): Promise<ParsedMemory> {
  const completion = await groq.chat.completions.create({
    model: "qwen/qwen3.6-27b",
    messages: [
      { role: "system", content: PARSE_SYSTEM },
      { role: "user", content: text },
    ],
    temperature: 0.1,
    max_tokens: 1000,
    response_format: { type: "json_object" },
    reasoning_effort: "none",
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);

  return {
    type: parsed.type || "note",
    domain: parsed.domain || "general",
    entities: parsed.entities || [],
    intent: parsed.intent || "save",
    time: parsed.time || { datetime: null, confidence: 0 },
    summary: parsed.summary || text,
  };
}

const SEARCH_SYSTEM = `You are a search assistant for a personal memory system. Given a user query and a list of stored memories, do the following:

1. Determine which memories are relevant to the query
2. Group them into meaningful clusters by topic
3. Generate a conversational response in the same language as the query

Respond ONLY with valid JSON:
{
  "clusters": [
    {
      "topic": "string (short topic label)",
      "emoji": "string (single emoji)",
      "items": ["item_id_1", "item_id_2"]
    }
  ],
  "response": "string (conversational summary in the user's language)",
  "expanded_query": "string (expanded version of the query for semantic matching)"
}

Rules:
- Only include genuinely relevant items
- Group logically
- Keep the response natural and helpful
- The response should reference actual content, not fabricate
- If nothing is relevant, say so honestly`;

export async function searchWithLLM(
  query: string,
  items: Array<{ id: string; content: string; type: string; domain: string; entities: string }>
) {
  const itemList = items
    .map((i) => `[${i.id}] (${i.type}/${i.domain}) ${i.content} | entities: ${i.entities || "none"}`)
    .join("\n");

  const completion = await groq.chat.completions.create({
    model: "qwen/qwen3.6-27b",
    messages: [
      { role: "system", content: SEARCH_SYSTEM },
      {
        role: "user",
        content: `Query: "${query}"\n\nStored memories:\n${itemList}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: "json_object" },
    reasoning_effort: "none",
  });

  const raw = completion.choices[0]?.message?.content || "{}";
  return JSON.parse(raw);
}

export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const uint8 = new Uint8Array(audioBuffer);
  const file = new File([uint8], "audio.webm", { type: "audio/webm" });
  const transcription = await groq.audio.transcriptions.create({
    file,
    model: "whisper-large-v3",
    language: "it",
  });
  return transcription.text;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const completion = await groq.chat.completions.create({
    model: "qwen/qwen3.6-27b",
    messages: [
      {
        role: "system",
        content:
          "Generate a semantic fingerprint of the following text as a JSON array of exactly 64 floating point numbers between -1 and 1 that capture the meaning. Respond ONLY with the JSON array.",
      },
      { role: "user", content: text },
    ],
    temperature: 0,
    max_tokens: 500,
    response_format: { type: "json_object" },
    reasoning_effort: "none",
  });

  const raw = completion.choices[0]?.message?.content || "[]";
  try {
    const parsed = JSON.parse(raw);
    const arr = parsed.embedding || parsed.vector || parsed;
    if (Array.isArray(arr) && arr.length > 0) return arr;
  } catch {
    // fallback
  }
  return Array.from({ length: 64 }, () => Math.random() * 2 - 1);
}
