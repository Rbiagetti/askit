/**
 * Local text embeddings — no API, no tokens, no network at runtime.
 *
 * Replaces the previous getEmbedding() in lib/groq.ts, which asked a chat model
 * to invent "64 floats capturing the meaning". A generative model cannot produce
 * coherent embeddings that way: the numbers were not comparable across calls,
 * and the error path returned Math.random(). See PIANO.md §1.2.
 *
 * Model: multilingual-e5-small (384 dims). Multilingual is not optional here —
 * notes are written in Italian and English-only models degrade badly on them.
 */
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const EMBED_MODEL = "Xenova/multilingual-e5-small";
export const EMBED_DIM = 384;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Loads the model once per process; ~120MB, cached on disk after first run.
 *
 * On Vercel: the native Node backend (onnxruntime-node, the only backend
 * transformers.js's Node build actually supports — "wasm" throws
 * "Unsupported device", it's browser-only there) dlopen()s a shared library
 * (libonnxruntime.so.1) at runtime instead of require()-ing it, so Next's
 * static file-tracing never sees the dependency. See next.config.ts for the
 * bundling story and PIANO.md §9 for the full account of what was tried.
 */
function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = pipeline("feature-extraction", EMBED_MODEL);
  }
  return extractor;
}

/**
 * E5 models require an asymmetric prefix and are meaningfully worse without it:
 * stored text is a "passage", the thing you search with is a "query".
 */
function withPrefix(text: string, kind: "query" | "passage"): string {
  return `${kind}: ${text.replace(/\s+/g, " ").trim()}`;
}

export async function embed(text: string, kind: "query" | "passage"): Promise<number[]> {
  const [vec] = await embedBatch([text], kind);
  return vec;
}

export async function embedBatch(
  texts: string[],
  kind: "query" | "passage"
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extract = await getExtractor();
  const output = await extract(
    texts.map((t) => withPrefix(t, kind)),
    { pooling: "mean", normalize: true }
  );
  // tolist() gives [batch][dim]; vectors are already L2-normalised
  return output.tolist() as number[][];
}
