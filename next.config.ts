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
  //
  // onnxruntime-node dlopen()s its native library (libonnxruntime.so.1) at
  // runtime instead of require()-ing it, so Next's static file-tracing never
  // sees the dependency — serverExternalPackages alone does NOT copy it
  // (confirmed: still "cannot open shared object file" on Vercel with only
  // the entry above, no outputFileTracingIncludes). Per-route
  // outputFileTracingIncludes keys (tried both "/api/**" and 5 exact routes)
  // each seem to force their route out of Next's shared function bundling
  // into its own function, hitting Hobby's 12-function-per-deployment cap
  // with only 9 base routes. Next's own docs list a single global "/*" key as
  // the intended pattern for exactly this case (native/runtime binaries like
  // sharp, aws-crt) — one entry, not one per route.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/**"],
  },
};

export default nextConfig;
