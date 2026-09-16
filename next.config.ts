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
  // the serverless function bundle. A first attempt included the whole
  // onnxruntime-node/bin/** tree (every platform: linux/win32/darwin x64/arm64)
  // under the broad "/api/**" key and hit Vercel's Hobby-plan 12-function-per-
  // deployment cap — scoping to the exact routes that use lib/embed.ts (directly
  // or via lib/retrieve.ts / lib/graph.ts) and to Linux only (Vercel's actual
  // runtime) avoids both problems.
  outputFileTracingIncludes: {
    "/api/parse": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/**"],
    "/api/items": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/**"],
    "/api/search": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/**"],
    "/api/reindex": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/**"],
    "/api/reanalyze": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/**"],
  },
};

export default nextConfig;
