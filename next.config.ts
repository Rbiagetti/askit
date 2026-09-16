import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 stays here for scripts/ (backfill/seed/rebuild CLIs, out of
  // scope for the Turso migration); @libsql/client is already in Next's own
  // default externals list (node_modules/next/dist/docs/.../serverExternalPackages.md)
  // but is listed explicitly for the same reason better-sqlite3 was.
  serverExternalPackages: ["better-sqlite3", "@libsql/client", "onnxruntime-node"],

  // Each route matched here costs 2 functions on Vercel (one per architecture,
  // apparently, regardless of which platform subfolder the glob names — seen
  // empirically, not documented). Baseline without any entries: 2 functions
  // total. Confirmed via a single-route diagnostic deploy before scaling to
  // all 5: 2 + 1×2 = 4. Full set: 2 + 5×2 = 12 — exactly Vercel Hobby's cap,
  // not over it. See lib/embed.ts and PIANO.md §9 for why this exists at all.
  outputFileTracingIncludes: {
    "/api/parse": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
    "/api/items": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
    "/api/search": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
    "/api/reindex": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
    "/api/reanalyze": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
  },
};

export default nextConfig;
