import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 stays here for scripts/ (backfill/seed/rebuild CLIs, out of
  // scope for the Turso migration); @libsql/client is already in Next's own
  // default externals list (node_modules/next/dist/docs/.../serverExternalPackages.md)
  // but is listed explicitly for the same reason better-sqlite3 was.
  serverExternalPackages: ["better-sqlite3", "@libsql/client", "onnxruntime-node"],

  // Each route matched here costs ~2 functions on Vercel (one per architecture,
  // apparently, regardless of which platform subfolder the glob names — seen
  // empirically, not documented, and not exactly linear: baseline with no
  // entries is 2 functions, one route measured at 4, but 5 routes (predicted
  // 12, exactly Vercel Hobby's cap) still failed exceeded_serverless_
  // functions_per_deployment — the real formula has some cost beyond a flat
  // 2/route once multiple keys are involved. Rather than keep spending deploy
  // cycles reverse-engineering it, scoped down to the 3 routes that matter
  // for daily use (create, edit, search a note). /api/reindex and
  // /api/reanalyze — maintenance endpoints from the Vault view, not part of
  // the core voice flow — will fail with "cannot open shared object file" on
  // Vercel until this is revisited (Vercel Pro removes the 12-function cap
  // entirely; Render/Fly/a Raspberry Pi have no such cap at all). See
  // lib/embed.ts and PIANO.md §9 for the full account.
  outputFileTracingIncludes: {
    "/api/parse": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
    "/api/items": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
    "/api/search": ["./node_modules/onnxruntime-node/bin/napi-v6/linux/x64/**"],
  },
};

export default nextConfig;
