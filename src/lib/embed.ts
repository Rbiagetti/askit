/**
 * Text embeddings via the Gemini embeddings API — no local model, no native
 * binaries, no cold-start model loading.
 *
 * History: the first version used transformers.js + onnxruntime-node running
 * locally. That worked, but onnxruntime-node dlopen()s a native shared library
 * that Next's static file-tracing can't see, which turned deploying to Vercel
 * into a multi-day fight against a 12-serverless-functions-per-deployment cap
 * (see PIANO.md §9) — and even once "fixed", every cold instance re-downloaded
 * ~120MB and took 10-15s before serving its first request. Gemini's embedding
 * API removes the problem at the root: no native dependency to bundle, no
 * model to load, and Groq (already in use for parsing/search) has no
 * embeddings endpoint at all — verified directly against the API, not assumed.
 *
 * Every request/response shape below (endpoint, field names, batch endpoint,
 * the outputDimensionality/taskType quirk) was verified against the real API
 * with a real key before writing this, not copied from the docs unchecked —
 * the docs recommend `embedContentConfig.outputDimensionality`, but nested
 * that way it's silently ignored; only the flat top-level field works.
 */

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-embedding-001";
const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}`;

export const EMBED_MODEL = `gemini/${MODEL}@768`;
export const EMBED_DIM = 768;

/**
 * Asymmetric task type, Gemini's equivalent of E5's query:/passage: prefixes:
 * stored text is a "document" to be found, the thing you search with is a
 * "query" — using the matching task type meaningfully improves retrieval
 * quality over treating both the same way.
 */
function taskType(kind: "query" | "passage"): string {
  return kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

async function callApi(path: string, body: unknown): Promise<unknown> {
  if (!API_KEY) throw new Error("GEMINI_API_KEY non impostata");
  const res = await fetch(`${BASE_URL}:${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini embeddings ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export async function embed(text: string, kind: "query" | "passage"): Promise<number[]> {
  const data = (await callApi("embedContent", {
    content: { parts: [{ text: clean(text) }] },
    taskType: taskType(kind),
    outputDimensionality: EMBED_DIM,
  })) as { embedding: { values: number[] } };
  return data.embedding.values;
}

export async function embedBatch(
  texts: string[],
  kind: "query" | "passage"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const requests = texts.map((t) => ({
    model: `models/${MODEL}`,
    content: { parts: [{ text: clean(t) }] },
    taskType: taskType(kind),
    outputDimensionality: EMBED_DIM,
  }));
  const data = (await callApi("batchEmbedContents", { requests })) as {
    embeddings: Array<{ values: number[] }>;
  };
  return data.embeddings.map((e) => e.values);
}
