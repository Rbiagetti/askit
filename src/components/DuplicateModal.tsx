"use client";

import { useState } from "react";
import { Memory } from "./types";
import { DuplicateCluster } from "@/lib/tfidf";

export default function DuplicateModal({
  clusters,
  memories,
  onMerge,
  onDeleteAll,
  onClose,
}: {
  clusters: DuplicateCluster[];
  memories: Memory[];
  onMerge: (keep: string, del: string[]) => void;
  onDeleteAll: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const getM = (id: string) => memories.find((m) => m.id === id);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.88)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-lg mx-4 mb-4 sm:mb-0"
        style={{
          background: "#0a0a0a",
          border: "1px solid var(--border)",
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <div className="glyph-dot glyph-dot-red" />
              <div className="glyph-dot glyph-dot-red" style={{ animationDelay: "0.25s" }} />
            </div>
            <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "var(--accent)" }}>
              {clusters.length} gruppi duplicati
            </span>
          </div>
          <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--fg-muted)" }}>
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {clusters.map((cluster, i) => (
            <div
              key={i}
              className="px-5 py-4 border-b border-[var(--border)] transition-opacity"
              style={{ opacity: done.has(i) ? 0.3 : 1 }}
            >
              <p className="text-[10px] tracking-[0.15em] uppercase mb-2" style={{ color: "var(--fg-muted)" }}>
                Gruppo {i + 1} — {cluster.ids.length} simili
              </p>
              <div className="space-y-1.5 mb-3">
                {cluster.ids.map((id) => {
                  const m = getM(id);
                  return m ? (
                    <div
                      key={id}
                      className="px-3 py-2 text-xs leading-snug"
                      style={{
                        background: id === cluster.representative ? "rgba(255,255,255,0.06)" : "transparent",
                        border: `1px solid ${
                          id === cluster.representative ? "rgba(255,255,255,0.15)" : "var(--border)"
                        }`,
                        color: id === cluster.representative ? "var(--accent)" : "var(--fg-dim)",
                      }}
                    >
                      {id === cluster.representative && (
                        <span className="mr-2 text-[10px]" style={{ color: "var(--green)" }}>
                          ★
                        </span>
                      )}
                      {m.content || m.text}
                    </div>
                  ) : null;
                })}
              </div>

              {!done.has(i) && (
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      const del = cluster.ids.filter((id) => id !== cluster.representative);
                      onMerge(cluster.representative, del);
                      setDone((s) => new Set(s).add(i));
                    }}
                    className="text-[10px] tracking-[0.1em] uppercase px-3 py-1.5"
                    style={{ background: "var(--fg)", color: "var(--bg)" }}
                  >
                    Merge
                  </button>
                  <button
                    onClick={() => {
                      onDeleteAll(cluster.ids);
                      setDone((s) => new Set(s).add(i));
                    }}
                    className="text-[10px] tracking-[0.1em] uppercase px-3 py-1.5 border"
                    style={{ borderColor: "var(--red)", color: "var(--red)" }}
                  >
                    Elimina tutte
                  </button>
                  <button
                    onClick={() => setDone((s) => new Set(s).add(i))}
                    className="text-[10px] tracking-[0.1em] uppercase px-3 py-1.5 border"
                    style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                  >
                    Ignora
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-[var(--border)] shrink-0">
          <button
            onClick={onClose}
            className="w-full text-[10px] tracking-[0.15em] uppercase py-1"
            style={{ color: "var(--fg-muted)" }}
          >
            Chiudi
          </button>
        </div>
      </div>
    </div>
  );
}
