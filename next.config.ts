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
  // sees the dependency on its own — that's why it's listed above explicitly,
  // same as better-sqlite3. Two follow-up attempts at also adding
  // outputFileTracingIncludes (first broadly for "/api/**", then scoped to the
  // 5 routes that actually use it) both failed the build outright with
  // "exceeded_serverless_functions_per_deployment" (Hobby's 12-function cap) —
  // each outputFileTracingIncludes key appears to force its route out of
  // Next's normal function bundling into its own separate function, which
  // this app's 9 base routes cannot afford even 3-4 of. serverExternalPackages
  // alone (below) already makes Next copy the whole onnxruntime-node package
  // verbatim, .so included, exactly as it does for better-sqlite3 — no
  // additional tracing directive needed.
};

export default nextConfig;
