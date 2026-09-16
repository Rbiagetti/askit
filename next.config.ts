import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 stays here for scripts/ (backfill/seed/rebuild CLIs, out of
  // scope for the Turso migration); @libsql/client is already in Next's own
  // default externals list (node_modules/next/dist/docs/.../serverExternalPackages.md)
  // but is listed explicitly for the same reason better-sqlite3 was.
  //
  // No onnxruntime-node here anymore, and no outputFileTracingIncludes either:
  // embeddings moved to the Gemini API (see lib/embed.ts), which removed the
  // native binary that made this file a multi-day fight against Vercel Hobby's
  // 12-functions-per-deployment cap (full story in PIANO.md §9). /api/reindex
  // and /api/reanalyze, which had been dropped from the deploy to stay under
  // that cap, work again now that nothing forces routes out of shared
  // function bundling.
  serverExternalPackages: ["better-sqlite3", "@libsql/client"],
};

export default nextConfig;
