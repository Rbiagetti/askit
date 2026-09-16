import Groq from "groq-sdk";
import { temporalContext, describeWhen } from "./temporal";

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
- Resolve every temporal reference against the "Current datetime" given in the user message,
  and always emit time.datetime as an ABSOLUTE ISO8601 timestamp with offset — never a relative
  expression. "domani alle 18" becomes the actual next-day date at 18:00.
- If no time is expressed, use null with confidence 0
- Keep summary concise and in the original language
- If unsure about type, default to "note"
- Never add entities that aren't clearly referenced`;

export async function parseMemory(text: string, now: Date = new Date()): Promise<ParsedMemory> {
  const completion = await groq.chat.completions.create({
    model: "qwen/qwen3.8-27b",
    messages: [
      { role: "system", content: PARSE_SYSTEM },
      { role: "user", content: `${temporalContext(now)}\n\nInput:\n${text}` },
    ],
    temperature: 0.1,
    // max_tokens is a reservation against the free tier's 1000 output-tokens-per-minute
    // limit, not just a cap: asking for more than needed throttles the whole app.
    // A parsed memory is ~150-250 tokens of JSON.
    max_tokens: 500,
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
- If nothing is relevant, say so honestly
- Each memory may carry a "when:" field already marked PASSATO or FUTURO relative to
  the current datetime. TRUST those labels — never re-derive whether a date is past or
  future from the text, and never call a PASSATO event upcoming.`;

export async function searchWithLLM(
  query: string,
  items: Array<{
    id: string;
    content: string;
    type: string;
    domain: string;
    entities: string;
    timeRef?: string | null;
  }>,
  now: Date = new Date()
) {
  const itemList = items
    .map((i) => {
      const when = describeWhen(i.timeRef, now);
      return (
        `[${i.id}] (${i.type}/${i.domain}) ${i.content}` +
        ` | entities: ${i.entities || "none"}` +
        (when ? ` | when: ${when}` : "")
      );
    })
    .join("\n");

  const completion = await groq.chat.completions.create({
    model: "qwen/qwen3.8-27b",
    messages: [
      { role: "system", content: SEARCH_SYSTEM },
      {
        role: "user",
        content: `${temporalContext(now)}\n\nQuery: "${query}"\n\nStored memories:\n${itemList}`,
      },
    ],
    temperature: 0.2,
    // 2000 exceeded the free tier's 1000 OTPM limit outright: every search returned
    // 429 "Request too large ... on output tokens per minute" without ever running.
    max_tokens: 900,
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

// getEmbedding() lived here and asked the chat model to invent a 64-float
// "semantic fingerprint", falling back to Math.random(). It has been replaced by
// real local embeddings — see lib/embed.ts and PIANO.md §1.2.

const LINK_SYSTEM = `You decide how a new note relates to a shortlist of existing notes.

Respond ONLY with valid JSON:
{"edges": [{"index": <number>, "type": "RELATES_TO"|"CONTINUES"|"CONTRADICTS"|"DUPLICATES", "confidence": 0.0-1.0}]}

Meaning:
- DUPLICATES  same fact restated; one could replace the other
- CONTINUES   follow-up or later development of the same thread
- CONTRADICTS states something incompatible with the other note
- RELATES_TO  genuinely connected but none of the above

Rules:
- Only include connections a person would agree with. Most pairs are NOT connected.
- Sharing a topic or a name is not enough on its own.
- Return an empty array rather than inventing links.
- Never include an index that is not in the list.`;

/**
 * Asks the model which of the shortlisted candidates are genuinely related.
 *
 * The only call in the system that reasons about structure, hence the raised
 * reasoning_effort. Kept small on purpose: max_tokens counts against the free
 * tier's 1000 output-tokens-per-minute limit, and reasoning tokens count too.
 */
export async function linkWithLLM(
  note: string,
  candidates: Array<{ id: string; content: string }>
): Promise<Array<{ id: string; type: string; confidence: number }>> {
  if (candidates.length === 0) return [];

  const list = candidates.map((c, i) => `[${i}] ${c.content}`).join("\n");
  const completion = await groq.chat.completions.create({
    model: "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: LINK_SYSTEM },
      { role: "user", content: `New note:\n${note}\n\nExisting notes:\n${list}` },
    ],
    temperature: 0.1,
    max_tokens: 400,
    response_format: { type: "json_object" },
    reasoning_effort: "low",
  });

  try {
    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
    return edges
      .filter(
        (e: { index?: number }) =>
          typeof e.index === "number" && e.index >= 0 && e.index < candidates.length
      )
      .map((e: { index: number; type: string; confidence?: number }) => ({
        id: candidates[e.index].id,
        type: e.type,
        confidence: typeof e.confidence === "number" ? e.confidence : 0.5,
      }));
  } catch {
    return [];
  }
}
