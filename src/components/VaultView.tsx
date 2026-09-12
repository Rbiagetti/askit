"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { TreeResponse, TreeDomain, TreeEntity } from "./types";
import NoteDetail from "./NoteDetail";

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

const ENTITY_ICONS: Record<string, string> = {
  person: "👤",
  place: "📍",
  movie: "🎬",
  concept: "💭",
};

function domainColor(domain: string | null): string {
  return DOMAIN_COLOR[domain || "general"] || DOMAIN_COLOR.general;
}

function domainLabel(domain: string | null): string {
  return domain || "senza categoria";
}

type Tab = "domain" | "entity";
type EntityKey = string; // `${name}::${type}`

/** Vault view: notes organized into folders (by domain, or by entity — drill-down),
 * with a detail panel showing the item's graph edges and a manual metadata override.
 *
 * Depends on GET /api/tree — see the PROVISIONAL note in src/app/api/tree/route.ts.
 */
export default function VaultView() {
  const [tab, setTab] = useState<Tab>("domain");
  const [tree, setTree] = useState<TreeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedDomain, setSelectedDomain] = useState<string | null>(null);
  const [domainPicked, setDomainPicked] = useState(false); // distinguishes "none selected" from "null domain selected"
  const [selectedEntityKey, setSelectedEntityKey] = useState<EntityKey | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/tree");
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTree(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Errore sconosciuto");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Mobile navigation level, derived from selection state (folders -> list -> detail).
  const level: "folders" | "list" | "detail" = selectedItemId
    ? "detail"
    : domainPicked || selectedEntityKey
    ? "list"
    : "folders";

  const selectDomainFolder = (d: string | null) => {
    setSelectedDomain(d);
    setDomainPicked(true);
    setSelectedItemId(null);
  };

  const selectEntityFolder = (key: EntityKey) => {
    setSelectedEntityKey(key);
    setSelectedItemId(null);
  };

  const backToFolders = () => {
    setDomainPicked(false);
    setSelectedDomain(null);
    setSelectedEntityKey(null);
    setSelectedItemId(null);
  };

  const switchTab = (t: Tab) => {
    setTab(t);
    backToFolders();
  };

  // How many distinct entities each item belongs to — so a note appearing under
  // several entity folders reads as intentional, not a bug.
  const entityCountByItem = useMemo(() => {
    const map = new Map<string, number>();
    for (const ent of tree?.entities || []) {
      for (const it of ent.items) map.set(it.id, (map.get(it.id) || 0) + 1);
    }
    return map;
  }, [tree]);

  const activeDomainGroup: TreeDomain | undefined = useMemo(() => {
    if (!domainPicked || !tree) return undefined;
    return tree.domains.find((d) => (d.domain || null) === selectedDomain);
  }, [tree, domainPicked, selectedDomain]);

  const activeEntityGroup: TreeEntity | undefined = useMemo(() => {
    if (!selectedEntityKey || !tree) return undefined;
    return tree.entities.find((e) => `${e.name}::${e.type}` === selectedEntityKey);
  }, [tree, selectedEntityKey]);

  const handleDomainChanged = useCallback(
    (itemId: string, newDomain: string) => {
      // The note may have moved to a different folder — refresh the tree so
      // counts and grouping stay correct, and follow it into its new folder.
      loadTree();
      if (tab === "domain") {
        setSelectedDomain(newDomain);
        setDomainPicked(true);
      }
      void itemId;
    },
    [loadTree, tab]
  );

  const exportVault = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch("/api/vault", { method: "POST" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(`Esportate ${data.notes} note · ${data.entities} entità · ${data.removed} rimossi`);
    } catch (e) {
      showToast(`Errore export: ${e instanceof Error ? e.message : "sconosciuto"}`, false);
    }
    setExporting(false);
  };

  const panelClass = (want: "folders" | "list" | "detail") =>
    `${level === want ? "flex" : "hidden"} md:flex flex-col overflow-hidden`;

  return (
    <div className="pt-3 pb-4 px-3 space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 px-1 flex-wrap">
        <div className="flex gap-1">
          <button
            onClick={() => switchTab("domain")}
            className="text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-all"
            style={{
              background: tab === "domain" ? "var(--fg)" : "transparent",
              color: tab === "domain" ? "var(--bg)" : "var(--fg-muted)",
              borderColor: tab === "domain" ? "var(--fg)" : "var(--border)",
            }}
          >
            Per dominio
          </button>
          <button
            onClick={() => switchTab("entity")}
            className="text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-all"
            style={{
              background: tab === "entity" ? "var(--fg)" : "transparent",
              color: tab === "entity" ? "var(--bg)" : "var(--fg-muted)",
              borderColor: tab === "entity" ? "var(--fg)" : "var(--border)",
            }}
          >
            Per entità
          </button>
        </div>
        <div className="flex items-center gap-2">
          {toast && (
            <span className="text-[10px]" style={{ color: toast.ok ? "var(--green)" : "var(--red)" }}>
              {toast.msg}
            </span>
          )}
          <button
            onClick={exportVault}
            disabled={exporting}
            className="text-[10px] tracking-[0.12em] uppercase px-2.5 py-1 border transition-all disabled:opacity-40"
            style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
            title="Rigenera il mirror markdown Obsidian (POST /api/vault)"
          >
            {exporting ? "Esporto..." : "⇩ Esporta vault"}
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex justify-center gap-2 py-16">
          <div className="glyph-dot" />
          <div className="glyph-dot" style={{ animationDelay: "0.4s" }} />
          <div className="glyph-dot" style={{ animationDelay: "0.8s" }} />
        </div>
      )}

      {!loading && error && (
        <div className="text-center py-10 space-y-2">
          <p className="text-xs" style={{ color: "var(--red)" }}>
            Errore nel caricare la vault: {error}
          </p>
          <button
            onClick={loadTree}
            className="text-[10px] tracking-[0.12em] uppercase px-3 py-1 border"
            style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
          >
            Riprova
          </button>
        </div>
      )}

      {!loading && !error && tree && (
        <div className="border border-[var(--border)] flex flex-col md:flex-row" style={{ height: "min(70vh, 640px)" }}>
          {/* ── Folders column ── */}
          <div className={`${panelClass("folders")} md:w-[34%] md:border-r md:border-[var(--border)]`}>
            <div className="overflow-y-auto flex-1">
              {tab === "domain" ? (
                tree.domains.length === 0 ? (
                  <p className="text-xs italic p-4" style={{ color: "var(--fg-dim)" }}>
                    Nessuna nota ancora.
                  </p>
                ) : (
                  tree.domains.map((d) => {
                    const key = d.domain || null;
                    const active = domainPicked && selectedDomain === key;
                    const color = domainColor(d.domain);
                    return (
                      <button
                        key={key ?? "__none__"}
                        onClick={() => selectDomainFolder(key)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left border-b border-[var(--border)] transition-colors"
                        style={{ background: active ? "rgba(255,255,255,0.06)" : "transparent" }}
                      >
                        <span className="flex items-center gap-2 text-xs" style={{ color: active ? "var(--fg)" : "var(--accent)" }}>
                          <span style={{ color }}>▸</span>
                          {domainLabel(d.domain)}
                        </span>
                        <span
                          className="text-[10px] px-1.5 py-0.5 shrink-0"
                          style={{ background: "rgba(255,255,255,0.05)", color: "var(--fg-muted)" }}
                        >
                          {d.items.length}
                        </span>
                      </button>
                    );
                  })
                )
              ) : tree.entities.length === 0 ? (
                <p className="text-xs italic p-4" style={{ color: "var(--fg-dim)" }}>
                  Nessuna entità ancora.
                </p>
              ) : (
                tree.entities.map((e) => {
                  const key = `${e.name}::${e.type}`;
                  const active = selectedEntityKey === key;
                  return (
                    <button
                      key={key}
                      onClick={() => selectEntityFolder(key)}
                      className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left border-b border-[var(--border)] transition-colors"
                      style={{ background: active ? "rgba(255,255,255,0.06)" : "transparent" }}
                    >
                      <span className="flex items-center gap-2 text-xs truncate" style={{ color: active ? "var(--fg)" : "var(--accent)" }}>
                        <span>{ENTITY_ICONS[e.type] || "•"}</span>
                        <span className="truncate">{e.name}</span>
                      </span>
                      <span
                        className="text-[10px] px-1.5 py-0.5 shrink-0"
                        style={{ background: "rgba(255,255,255,0.05)", color: "var(--fg-muted)" }}
                      >
                        {e.items.length}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ── List column ── */}
          <div className={`${panelClass("list")} md:w-[33%] md:border-r md:border-[var(--border)]`}>
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] shrink-0 md:hidden">
              <button onClick={backToFolders} className="text-sm" style={{ color: "var(--fg-muted)" }}>
                ←
              </button>
              <span className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                {tab === "domain" ? domainLabel(selectedDomain) : activeEntityGroup?.name || ""}
              </span>
            </div>
            <div className="overflow-y-auto flex-1">
              {tab === "domain" ? (
                !activeDomainGroup ? (
                  <p className="text-xs italic p-4" style={{ color: "var(--fg-dim)" }}>
                    Seleziona una cartella.
                  </p>
                ) : activeDomainGroup.items.length === 0 ? (
                  <p className="text-xs italic p-4" style={{ color: "var(--fg-dim)" }}>
                    Cartella vuota.
                  </p>
                ) : (
                  activeDomainGroup.items.map((it) => {
                    const active = selectedItemId === it.id;
                    const extra = entityCountByItem.get(it.id) || 0;
                    return (
                      <button
                        key={it.id}
                        onClick={() => setSelectedItemId(it.id)}
                        className="w-full text-left px-3 py-2.5 border-b border-[var(--border)] transition-colors"
                        style={{ background: active ? "rgba(255,255,255,0.06)" : "transparent" }}
                      >
                        <div className="flex items-center gap-1.5 mb-1">
                          <span style={{ color: domainColor(it.domain), fontSize: 11 }}>{TYPE_ICONS[it.type] || "○"}</span>
                          <span className="text-[10px]" style={{ color: "var(--fg-muted)" }}>{it.type}</span>
                        </div>
                        <p className="text-xs leading-snug line-clamp-2" style={{ color: "var(--accent)" }}>
                          {it.content}
                        </p>
                        {extra > 1 && (
                          <p className="text-[9px] mt-1" style={{ color: "var(--fg-dim)" }}>
                            in {extra} entità
                          </p>
                        )}
                      </button>
                    );
                  })
                )
              ) : !activeEntityGroup ? (
                <p className="text-xs italic p-4" style={{ color: "var(--fg-dim)" }}>
                  Seleziona un&apos;entità.
                </p>
              ) : activeEntityGroup.items.length === 0 ? (
                <p className="text-xs italic p-4" style={{ color: "var(--fg-dim)" }}>
                  Nessuna nota per questa entità.
                </p>
              ) : (
                activeEntityGroup.items.map((it) => {
                  const active = selectedItemId === it.id;
                  const extra = entityCountByItem.get(it.id) || 0;
                  return (
                    <button
                      key={it.id}
                      onClick={() => setSelectedItemId(it.id)}
                      className="w-full text-left px-3 py-2.5 border-b border-[var(--border)] transition-colors"
                      style={{ background: active ? "rgba(255,255,255,0.06)" : "transparent" }}
                    >
                      <p className="text-xs leading-snug line-clamp-2" style={{ color: "var(--accent)" }}>
                        {it.content}
                      </p>
                      {extra > 1 && (
                        <p className="text-[9px] mt-1" style={{ color: "var(--fg-dim)" }}>
                          anche in altre {extra - 1} entità
                        </p>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ── Detail column ── */}
          <div className={`${panelClass("detail")} flex-1`}>
            {selectedItemId ? (
              <NoteDetail
                itemId={selectedItemId}
                onClose={() => setSelectedItemId(null)}
                onBack={() => setSelectedItemId(null)}
                showBack
                onDomainChanged={handleDomainChanged}
                onNavigate={(id) => setSelectedItemId(id)}
              />
            ) : (
              <div className="hidden md:flex flex-1 items-center justify-center h-full">
                <p className="text-xs italic" style={{ color: "var(--fg-dim)" }}>
                  Seleziona una nota per vederne il dettaglio.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
