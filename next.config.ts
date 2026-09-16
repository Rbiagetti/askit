import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 stays here for scripts/ (backfill/seed/rebuild CLIs, out of
  // scope for the Turso migration); @libsql/client is already in Next's own
  // default externals list (node_modules/next/dist/docs/.../serverExternalPackages.md)
  // but is listed explicitly for the same reason better-sqlite3 was.
  serverExternalPackages: ["better-sqlite3", "@libsql/client", "onnxruntime-node"],

  // DIAGNOSTIC deploy, not a final fix — see PIANO.md §9 for the full story.
  // Testing whether a single route + single architecture stays under Vercel
  // Hobby's 12-function cap, to learn the real per-route cost before deciding
  // whether this approach can cover all 5 routes that need onnxruntime-node.
  outputFileTracingIncludes: {
    "/api/parse": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
  },
};

export default nextConfig;
