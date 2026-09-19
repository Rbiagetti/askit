"use client";

import { useState, useEffect } from "react";
import { parseDbDate } from "@/lib/dates";
import { ItemDetailResponse } from "./types";

const TYPE_ICONS: Record<string, string> = {
  note: "○",
  task: "◇",
  wishlist: "☆",
  idea: "◈",
  reminder: "◎",
};

const DOMAIN_COLOR: Record<string, string> = {
  food: "#ff9f43",
  travel: "#54a0ff",
  work: "#a29bfe",
  health: "#00cec9",
  cinema: "#fd79a8",
  tech: "#74b9ff",
  music: "#b2bec3",
  learning: "#55efc4",
  shopping: "#fdcb6e",
  finance: "#ff7675",
  pets: "#81ecec",
  general: "#636e72",
};

const KNOWN_DOMAINS = Object.keys(DOMAIN_COLOR);

/** Human labels for the graph edge types (PIANO.md §3 / src/lib/db.ts `edges`). */
const EDGE_LABEL: Record<string, string> = {
  SIMILAR_TO: "simile a",
  CO_OCCURS: "co-occorre con",
  DUPLICATES: "duplica",
  CONTINUES: "continua",
  CONTRADICTS: "contraddice",
  RELATES_TO: "collegata a",
};

const EDGE_COLOR: Record<string, string> = {
  SIMILAR_TO: "var(--blue)",
  CO_OCCURS: "var(--fg-muted)",
  DUPLICATES: "var(--red)",
  CONTINUES: "var(--green)",
  CONTRADICTS: "var(--red)",
  RELATES_TO: "var(--accent)",
};

function fmtDate(iso: string): string {
  const d = parseDbDate(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("it-IT", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function NoteDetail({
  itemId,
  onClose,
  onBack,
  onDomainChanged,
  onNavigate,
  showBack = false,
}: {
  itemId: string;
  onClose: () => void;
  onBack?: () => void;
  /** Fired after a successful manual domain override, so the folder tree can refresh. */
  onDomainChanged?: (itemId: string, domain: string) => void;
  /** Fired when the user clicks a graph-linked note, to drill into it instead. */
  onNavigate?: (itemId: string) => void;
  showBack?: boolean;
}) {
  const [detail, setDetail] = useState<ItemDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingDomain, setEditingDomain] = useState(false);
  const [domainDraft, setDomainDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // State (loading, editing, errors) starts fresh for every note because the parent
  // renders this with key={itemId}, so this effect only has to fetch — no synchronous
  // resets inside the effect body.
  useEffect(() => {
    let alive = true;
    fetch(`/api/items/${itemId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        if (alive) setDetail(data);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Errore sconosciuto");
        setDetail(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [itemId]);

  const startEditDomain = () => {
    setDomainDraft(detail?.item.domain || "general");
    setSaveError(null);
    setEditingDomain(true);
  };

  const saveDomain = async () => {
    const value = domainDraft.trim();
    if (!value || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch("/api/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: itemId, domain: value }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setDetail((prev) =>
        prev ? { ...prev, item: { ...prev.item, domain: value, domainLocked: true } } : prev
      );
      setEditingDomain(false);
      onDomainChanged?.(itemId, value);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Errore sconosciuto");
    }
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)] shrink-0">
        {showBack && onBack && (
          <button onClick={onBack} className="text-sm" style={{ color: "var(--fg-muted)" }} title="Indietro">
            ←
          </button>
        )}
        <span className="text-[11px] tracking-[0.2em] uppercase flex-1" style={{ color: "var(--accent)" }}>
          Dettaglio nota
        </span>
        <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--fg-muted)" }}>
          ×
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {loading && (
          <div className="flex justify-center gap-2 py-10">
            <div className="glyph-dot" />
            <div className="glyph-dot" style={{ animationDelay: "0.4s" }} />
            <div className="glyph-dot" style={{ animationDelay: "0.8s" }} />
          </div>
        )}

        {!loading && error && (
          <p className="text-xs" style={{ color: "var(--red)" }}>
            Errore: {error}
          </p>
        )}

        {!loading && detail && (
          <>
            {/* Content */}
            <div>
              <p className="text-sm leading-relaxed" style={{ color: "var(--accent)" }}>
                {detail.item.content}
              </p>
              {detail.item.rawText && detail.item.rawText.trim() !== detail.item.content.trim() && (
                <div
                  className="mt-2 px-3 py-2 text-xs leading-snug italic"
                  style={{ background: "rgba(255,255,255,0.03)", border: "1px solid var(--border)", color: "var(--fg-dim)" }}
                >
                  “{detail.item.rawText}”
                </div>
              )}
            </div>

            {/* Metadata */}
            <div className="space-y-2">
              <p className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                Metadati
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <span
                  className="text-[10px] px-1.5 py-0.5"
                  style={{
                    background: (DOMAIN_COLOR[detail.item.domain || "general"] || DOMAIN_COLOR.general) + "22",
                    color: DOMAIN_COLOR[detail.item.domain || "general"] || DOMAIN_COLOR.general,
                    border: `1px solid ${(DOMAIN_COLOR[detail.item.domain || "general"] || DOMAIN_COLOR.general)}44`,
                  }}
                >
                  {TYPE_ICONS[detail.item.type] || "○"} {detail.item.type}
                </span>

                {!editingDomain ? (
                  <button
                    onClick={startEditDomain}
                    className="text-[10px] px-1.5 py-0.5 flex items-center gap-1"
                    style={{ background: "rgba(255,255,255,0.04)", color: "var(--fg-muted)", border: "1px solid var(--border)" }}
                    title="Correggi dominio manualmente"
                  >
                    {detail.item.domain || "senza categoria"}
                    {detail.item.domainLocked && <span style={{ color: "var(--green)" }}>🔒</span>}
                    <span style={{ color: "var(--fg-dim)" }}>✎</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1">
                    <input
                      value={domainDraft}
                      onChange={(e) => setDomainDraft(e.target.value)}
                      list="vault-domain-suggestions"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveDomain();
                        if (e.key === "Escape") setEditingDomain(false);
                      }}
                      className="text-[10px] px-1.5 py-0.5 focus:outline-none"
                      style={{ background: "var(--bg-input)", border: "1px solid var(--border-focus)", color: "var(--fg)", width: 110 }}
                    />
                    <datalist id="vault-domain-suggestions">
                      {KNOWN_DOMAINS.map((d) => (
                        <option key={d} value={d} />
                      ))}
                    </datalist>
                    <button
                      onClick={saveDomain}
                      disabled={saving || !domainDraft.trim()}
                      className="text-[10px] px-1.5 py-0.5 disabled:opacity-30"
                      style={{ background: "var(--fg)", color: "var(--bg)" }}
                    >
                      {saving ? "…" : "✓"}
                    </button>
                    <button
                      onClick={() => setEditingDomain(false)}
                      className="text-[10px] px-1.5 py-0.5 border"
                      style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                    >
                      ×
                    </button>
                  </div>
                )}

                {typeof detail.item.importance === "number" && (
                  <span className="text-[10px]" style={{ color: "var(--fg-muted)" }}>
                    importanza {(detail.item.importance * 100).toFixed(0)}%
                  </span>
                )}
              </div>
              {saveError && (
                <p className="text-[10px]" style={{ color: "var(--red)" }}>
                  Errore: {saveError}
                </p>
              )}
              <p className="text-[10px]" style={{ color: "var(--fg-muted)" }}>
                Creata {fmtDate(detail.item.createdAt)}
                {detail.item.timeRef && <> · scadenza {fmtDate(detail.item.timeRef)}</>}
                {detail.item.usageCount > 0 && <> · usata {detail.item.usageCount}×</>}
              </p>
            </div>

            {/* Entities */}
            {detail.entities.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                  Entità
                </p>
                <div className="flex gap-1 flex-wrap">
                  {detail.entities.map((e) => (
                    <span
                      key={`${e.name}-${e.type}`}
                      className="text-[10px] px-1.5 py-0.5"
                      style={{ background: "rgba(255,255,255,0.05)", color: "var(--fg-dim)" }}
                    >
                      #{e.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Graph edges — the part missing everywhere else in the UI */}
            <div className="space-y-1.5">
              <p className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                Collegamenti nel grafo {detail.edges.length > 0 && `(${detail.edges.length})`}
              </p>
              {detail.edges.length === 0 ? (
                <p className="text-xs italic" style={{ color: "var(--fg-dim)" }}>
                  Nessun arco item↔item per questa nota.
                </p>
              ) : (
                <div className="space-y-1">
                  {detail.edges.map((edge) => (
                    <button
                      key={edge.id}
                      onClick={() => onNavigate?.(edge.partner.id)}
                      className="w-full text-left px-3 py-2 transition-colors"
                      style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}
                    >
                      <div className="flex items-center gap-1.5 mb-1">
                        <span
                          className="text-[9px] px-1 py-0.5 tracking-wide uppercase"
                          style={{
                            color: EDGE_COLOR[edge.edgeType] || "var(--accent)",
                            border: `1px solid ${EDGE_COLOR[edge.edgeType] || "var(--border)"}`,
                          }}
                        >
                          {EDGE_LABEL[edge.edgeType] || edge.edgeType.toLowerCase()}
                        </span>
                        <span className="text-[9px]" style={{ color: "var(--fg-muted)" }}>
                          peso {edge.weight.toFixed(2)}
                        </span>
                      </div>
                      <p className="text-xs leading-snug truncate" style={{ color: "var(--fg-dim)" }}>
                        {edge.partner.content}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
