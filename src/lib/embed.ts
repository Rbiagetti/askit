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
 * TODO(deploy/Vercel): on serverless this cache does not survive between cold
 * starts — each new instance re-downloads ~120MB from the Hugging Face hub
 * before it can serve its first request. Not fixed here (out of scope for the
 * Turso migration); the fix, when needed:
 *   1. `npx @huggingface/transformers-cli download Xenova/multilingual-e5-small`
 *      (or an equivalent download script) into a repo folder, e.g. `models/`,
 *      as a `postinstall`/prebuild step so Vercel's build includes the weights.
 *   2. At the top of this file, before the first `pipeline()` call:
 *        import { env } from "@huggingface/transformers";
 *        env.allowRemoteModels = false;
 *        env.localModelPath = path.join(process.cwd(), "models");
 *   3. Confirm the folder isn't excluded by `.vercelignore`/`.gitignore`, and
 *      that it fits Vercel's deployment size limits (~120MB should be fine).
 * Until this is done, expect slow (10-20s+) cold starts on Vercel for the
 * first request per instance; subsequent requests on the same warm instance
 * are unaffected since `extractor` is memoized per process.
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
