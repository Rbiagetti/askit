import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 stays here for scripts/ (backfill/seed/rebuild CLIs, out of
  // scope for the Turso migration); @libsql/client is already in Next's own
  // default externals list (node_modules/next/dist/docs/.../serverExternalPackages.md)
  // but is listed explicitly for the same reason better-sqlite3 was.
  // onnxruntime-node (transformers.js's inference engine, used by lib/embed.ts)
  // is NOT in that default list and needs it: without it, Turbopack tries to
  // bundle the package instead of leaving it as plain node_modules on disk.
  serverExternalPackages: ["better-sqlite3", "@libsql/client", "onnxruntime-node"],

  // Found by deploying to Vercel, not from docs: onnxruntime-node dlopen()s its
  // native library (libonnxruntime.so.1) at runtime instead of require()-ing it,
  // so Next's static file-tracing never sees the dependency and leaves it out of
  // the serverless function bundle — every route that embeds text (parse, items,
  // items/[id], search, reindex, reanalyze) failed with "cannot open shared
  // object file". Forcing inclusion of the whole platform-binaries folder fixes it.
  outputFileTracingIncludes: {
    "/api/**": ["./node_modules/onnxruntime-node/bin/**"],
  },
};

export default nextConfig;
