"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { detectDuplicates, DuplicateCluster } from "@/lib/tfidf";
import { Memory, SearchResult } from "@/components/types";
import EditModal from "@/components/EditModal";
import MemoryCard from "@/components/MemoryCard";
import DuplicateModal from "@/components/DuplicateModal";
import VaultView from "@/components/VaultView";

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"add" | "search" | "calendar" | "vault">("add");
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  // Removed askResult state (unified search)
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [dupClusters, setDupClusters] = useState<DuplicateCluster[]>([]);
  const [showDup, setShowDup] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [selectedDateKey, setSelectedDateKey] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Load from SQLite on mount ──
  useEffect(() => {
    fetch("/api/items")
      .then((r) => r.json())
      .then((d) => {
        setMemories(d.items || []);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    const tok = localStorage.getItem("sb_tokens");
    if (tok) {
      setTimeout(() => {
        setTotalTokens(parseInt(tok));
      }, 0);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("sb_tokens", String(totalTokens));
  }, [totalTokens]);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  };

  const toDateKey = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const parseTimeRef = (value?: string | null): Date | null => {
    if (!value) return null;
    const dt = new Date(value);
    return Number.isNaN(dt.getTime()) ? null : dt;
  };

  // ── Add memory → save to SQLite ──
  const addMemory = async () => {
    if (!input.trim() || processing) return;
    setProcessing(true);
    const raw = input;
    setInput("");
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: raw }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      const newMem: Memory = {
        id: data.id,
        text: raw,
        content: data.content || raw,
        type: data.type || "note",
        domain: data.domain || "general",
        entities: data.entities || [],
        timestamp: Date.now(),
        usageCount: 0,
        timeRef: data.timeRef || null,
        timeConfidence: data.timeConfidence || 0,
      };
      setMemories((prev) => [newMem, ...prev]);
      showToast(`${data.type} · ${data.domain}`);
    } catch (e) {
      setInput(raw);
      showToast(`Errore: ${e instanceof Error ? e.message : "sconosciuto"}`, false);
    }
    setProcessing(false);
  };


  // askQuestion removed – unified under search mode




  // ── Delete → SQLite ──
  const deleteMemory = useCallback((id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    // removed askResult update
    fetch("/api/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    showToast("Eliminata");
  }, []);

  // ── Update memory → SQLite ──
  const updateMemory = async (id: string, text: string) => {
    const res = await fetch("/api/items", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, text }),
    });
    const data = await res.json();
    if (data.error) { showToast(`Errore: ${data.error}`, false); return; }
    setMemories((prev) =>
      prev.map((m) =>
        m.id === id
          ? {
              ...m,
              text,
              content: data.content,
              type: data.type,
              domain: data.domain,
              entities: data.entities,
              timeRef: data.timeRef || null,
              timeConfidence: data.timeConfidence || 0,
            }
          : m
      )
    );
    showToast("Memoria aggiornata");
  };

  // ── Detect duplicates (client-side TF-IDF) ──
  const runDupDetection = () => {
    const clusters = detectDuplicates(memories.map((m) => ({ id: m.id, text: m.content || m.text })));
    if (!clusters.length) { showToast("Nessun duplicato trovato"); return; }
    setDupClusters(clusters);
    setShowDup(true);
  };

  const handleMerge = (keepId: string, delIds: string[]) => {
    delIds.forEach((id) => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      fetch("/api/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    });
    showToast(`Merge: tenuta 1, eliminate ${delIds.length}`);
  };

  const handleDeleteAll = (ids: string[]) => {
    ids.forEach((id) => {
      setMemories((prev) => prev.filter((m) => m.id !== id));
      fetch("/api/items", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    });
    showToast(`Eliminate ${ids.length}`);
  };

  // ── Voice ──
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setProcessing(true);
        try {
          const fd = new FormData();
          fd.append("audio", new Blob(chunksRef.current, { type: "audio/webm" }), "rec.webm");
          const res = await fetch("/api/transcribe", { method: "POST", body: fd });
          const d = await res.json();
          if (d.text) setInput(d.text);
        } catch { showToast("Errore trascrizione", false); }
        setProcessing(false);
      };
      mr.start();
      setRecording(true);
    } catch { showToast("Microfono non disponibile", false); }
  };

  const stopRecording = () => { mediaRecorderRef.current?.stop(); setRecording(false); };

  const executeSearch = async () => {
    if (!input.trim() || processing) return;
    setProcessing(true);
    setSearchResult(null);
    const query = input;
    setInput("");
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setSearchResult(data);
    } catch (e) {
      showToast(`Errore: ${e instanceof Error ? e.message : "sconosciuto"}`, false);
    }
    setProcessing(false);
  };

  const selectMode = (m: "add" | "search" | "calendar" | "vault") => {
    setMode(m);
    setSearchResult(null);
  };

  const handleSubmit = () => {
    if (mode === "add") addMemory();
    else if (mode === "search") executeSearch();
  };

  const datedMemories = memories
    .map((m) => {
      const dt = parseTimeRef(m.timeRef);
      return dt ? { memory: m, date: dt, key: toDateKey(dt) } : null;
    })
    .filter((x): x is { memory: Memory; date: Date; key: string } => x !== null);

  const calendarCounts = datedMemories.reduce<Record<string, number>>((acc, item) => {
    acc[item.key] = (acc[item.key] || 0) + 1;
    return acc;
  }, {});

  const monthStart = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const monthEnd = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0);
  const firstWeekday = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();

  const selectedDayMemories = selectedDateKey
    ? datedMemories.filter((item) => item.key === selectedDateKey).map((item) => item.memory)
    : [];

  // removed relevantMems (ask mode eliminated)

  return (
    <div className="dot-grid flex flex-col" style={{ height: "100dvh", overflow: "hidden" }}>

      {/* ── FIXED HEADER ── */}
      <header
        className="shrink-0 border-b border-[var(--border)] px-4 pt-4 pb-3 space-y-3"
        style={{ background: "rgba(0,0,0,0.96)", backdropFilter: "blur(16px)" }}
      >
        <div className="max-w-2xl mx-auto space-y-3">
          {/* Logo + toast */}
          <div className="flex items-center justify-between h-5">
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                <div className="glyph-dot" />
                <div className="glyph-dot" style={{ animationDelay: "0.3s" }} />
                <div className="glyph-dot" style={{ animationDelay: "0.6s" }} />
              </div>
              <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "var(--accent)" }}>
                Second Brain
              </span>
            </div>
            {toast && (
              <span className="text-[10px] fade-in" style={{ color: toast.ok ? "var(--green)" : "var(--red)" }}>
                {toast.msg}
              </span>
            )}
          </div>

          {/* Mode selector */}
          <div className="flex gap-1">
            {(["add", "search", "calendar", "vault"] as const).map((m) => (
              <button
                key={m}
                onClick={() => selectMode(m)}
                className="text-[10px] tracking-[0.15em] uppercase px-3 py-1 transition-all"
                style={{
                  background: mode === m ? "var(--fg)" : "transparent",
                  color: mode === m ? "var(--bg)" : "var(--fg-muted)",
                  border: mode === m ? "1px solid var(--fg)" : "1px solid var(--border)",
                }}
              >
                {m === "add" ? "+ Aggiungi" : m === "search" ? "🔍 Cerca" : m === "calendar" ? "📅 Calendar" : "🗂 Vault"}
              </button>
            ))}
          </div>

          {/* Input row */}
          {mode !== "calendar" && mode !== "vault" && <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
              placeholder={
                mode === "add"
                  ? "Scrivi o detta qualcosa da ricordare..."
                  : "Fai una domanda alle tue memorie o cerca..."
              }
              rows={2}
              className="flex-1 resize-none text-sm focus:outline-none transition-colors"
              style={{
                background: "var(--bg-input)",
                border: `1px solid ${input ? "var(--border-focus)" : "var(--border)"}`,
                color: "var(--fg)",
                fontFamily: "inherit",
                padding: "9px 12px",
              }}
            />
            {/* Mic button */}
            <div className="flex flex-col gap-1.5">
              <button
                onClick={recording ? stopRecording : startRecording}
                disabled={processing}
                className="w-9 h-9 flex items-center justify-center border transition-all"
                style={{
                  borderColor: recording ? "var(--red)" : "var(--border)",
                  background: recording ? "rgba(255,59,48,0.12)" : "transparent",
                }}
                title={recording ? "Ferma" : "Registra"}
              >
                <div
                  className={`w-2.5 h-2.5 rounded-full ${recording ? "recording-pulse" : ""}`}
                  style={{ background: recording ? "var(--red)" : "var(--fg-dim)" }}
                />
              </button>
              {/* Duplicate detect */}
              <button
                onClick={runDupDetection}
                disabled={memories.length < 2}
                className="w-9 h-9 flex items-center justify-center border transition-all disabled:opacity-20"
                style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                title="Trova memorie simili o duplicate"
              >
                <svg width="15" height="15" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="1" y="4" width="8" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2"/>
                  <rect x="5" y="1" width="8" height="10" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="rgba(0,0,0,0.8)"/>
                  <line x1="7.5" y1="5" x2="7.5" y2="9" stroke="currentColor" strokeWidth="1.2"/>
                  <line x1="5.5" y1="7" x2="9.5" y2="7" stroke="currentColor" strokeWidth="1.2"/>
                </svg>
              </button>
            </div>
          </div>}

          {/* Submit */}
          {mode !== "calendar" && mode !== "vault" && <button
            onClick={handleSubmit}
            disabled={processing || !input.trim()}
            className="w-full py-2 text-[11px] tracking-[0.15em] uppercase transition-all disabled:opacity-25"
            style={{ background: "var(--fg)", color: "var(--bg)" }}
          >
            {processing ? "..." : mode === "add" ? "Salva memoria  ⌘↵" : "Cerca  ⌘↵"}

          </button>}
        </div>
      </header>

      {/* ── SCROLLABLE BODY ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto">


          {/* Search result block */}
          {mode !== "calendar" && mode !== "vault" && searchResult && (
            <div className="fade-in border-b border-[var(--border)] px-4 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                  🔍 RISERCA SEMANTICA
                </p>
                <button
                  onClick={() => setSearchResult(null)}
                  className="text-[10px] tracking-wider uppercase"
                  style={{ color: "var(--fg-muted)" }}
                >
                  × chiudi
                </button>
              </div>

              {searchResult.response && (
                <div
                  className="px-4 py-3 text-sm leading-relaxed"
                  style={{ background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)", color: "var(--accent)" }}
                >
                  {searchResult.response}
                </div>
              )}

              {searchResult.clusters && searchResult.clusters.length > 0 ? (
                <div className="space-y-4">
                  {searchResult.clusters.map((cluster, idx) => {
                    const clusterMems = memories.filter((m) => cluster.items.includes(m.id));
                    if (clusterMems.length === 0) return null;
                    return (
                      <div key={idx} className="space-y-1">
                        <div className="flex items-center gap-1.5 px-1">
                          <span className="text-xs">{cluster.emoji}</span>
                          <span className="text-[10px] tracking-[0.12em] uppercase font-mono" style={{ color: "var(--accent)" }}>
                            {cluster.topic} ({clusterMems.length})
                          </span>
                        </div>
                        <div className="space-y-0.5">
                          {clusterMems.map((m) => (
                            <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} onEdit={setEditingMemory} highlight />
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs italic text-center py-2" style={{ color: "var(--fg-dim)" }}>
                  Nessun risultato rilevante trovato.
                </p>
              )}
            </div>
          )}
          {/* Vault view */}
          {mode === "vault" && loaded && <VaultView />}

          {/* Calendar view */}
          {mode === "calendar" && loaded && (
            <div className="pt-3 pb-4 px-3 space-y-3">
              <div className="flex items-center justify-between px-1">
                <button
                  onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))}
                  className="px-2 py-1 text-[10px] uppercase border"
                  style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                >
                  ← mese
                </button>
                <span className="text-[11px] tracking-[0.12em] uppercase" style={{ color: "var(--accent)" }}>
                  {calendarMonth.toLocaleDateString("it-IT", { month: "long", year: "numeric" })}
                </span>
                <button
                  onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))}
                  className="px-2 py-1 text-[10px] uppercase border"
                  style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                >
                  mese →
                </button>
              </div>

              <div className="grid grid-cols-7 gap-1 px-1">
                {["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"].map((label) => (
                  <div key={label} className="text-center text-[10px] uppercase" style={{ color: "var(--fg-muted)" }}>
                    {label}
                  </div>
                ))}

                {Array.from({ length: firstWeekday }).map((_, idx) => (
                  <div key={`empty-${idx}`} />
                ))}

                {Array.from({ length: daysInMonth }).map((_, idx) => {
                  const day = idx + 1;
                  const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day);
                  const key = toDateKey(date);
                  const count = calendarCounts[key] || 0;
                  const selected = selectedDateKey === key;
                  return (
                    <button
                      key={key}
                      onClick={() => setSelectedDateKey(key)}
                      className="min-h-12 p-1 border text-left transition-colors"
                      style={{
                        borderColor: selected ? "var(--fg)" : "var(--border)",
                        background: count > 0 ? "rgba(255,255,255,0.04)" : "transparent",
                        color: selected ? "var(--fg)" : "var(--accent)",
                      }}
                    >
                      <div className="text-[11px]">{day}</div>
                      {count > 0 && (
                        <div className="text-[10px]" style={{ color: "var(--green)" }}>
                          {count} nota{count > 1 ? "e" : ""}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="border border-[var(--border)] p-3">
                {!selectedDateKey ? (
                  <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
                    Seleziona un giorno per vedere le note con data.
                  </p>
                ) : selectedDayMemories.length === 0 ? (
                  <p className="text-xs" style={{ color: "var(--fg-muted)" }}>
                    Nessuna nota con data in questo giorno.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {selectedDayMemories.map((m) => (
                      <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} onEdit={setEditingMemory} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Memory list */}
          {mode !== "calendar" && mode !== "vault" && !loaded ? (
            <div className="flex justify-center gap-2 py-16">
              <div className="glyph-dot" />
              <div className="glyph-dot" style={{ animationDelay: "0.4s" }} />
              <div className="glyph-dot" style={{ animationDelay: "0.8s" }} />
            </div>
          ) : mode !== "calendar" && mode !== "vault" && memories.length === 0 ? (
            <div className="text-center py-20 space-y-3">
              <div className="flex justify-center gap-2">
                <div className="glyph-dot" />
                <div className="glyph-dot" style={{ animationDelay: "0.4s" }} />
                <div className="glyph-dot" style={{ animationDelay: "0.8s" }} />
              </div>
              <p className="text-xs tracking-wider" style={{ color: "var(--fg-muted)" }}>
                Nessuna memoria. Inizia scrivendo qualcosa.
              </p>
            </div>
          ) : mode !== "calendar" && mode !== "vault" ? (
            <div className="pt-2 pb-4">
              {memories.map((m) => (
                <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} onEdit={setEditingMemory} />
              ))}
            </div>
          ) : null}
        </div>
      </main>

      {/* ── FIXED FOOTER ── */}
      <footer
        className="shrink-0 border-t border-[var(--border)] px-4 py-2"
        style={{ background: "rgba(0,0,0,0.96)", backdropFilter: "blur(16px)" }}
      >
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: loaded ? "var(--green)" : "var(--fg-muted)" }} />
            <span className="text-[10px] tracking-[0.12em] uppercase" style={{ color: "var(--fg-muted)" }}>
              {memories.length} {memories.length === 1 ? "memoria" : "memorie"}
            </span>
          </div>
          <span className="text-[10px]" style={{ color: "var(--fg-muted)" }}>
            {totalTokens > 0 ? `${totalTokens.toLocaleString("it-IT")} token usati` : "local-first · sqlite"}
          </span>
        </div>
      </footer>

      {/* ── DUPLICATE MODAL ── */}
      {showDup && dupClusters.length > 0 && (
        <DuplicateModal
          clusters={dupClusters}
          memories={memories}
          onMerge={handleMerge}
          onDeleteAll={handleDeleteAll}
          onClose={() => setShowDup(false)}
        />
      )}

      {/* ── EDIT MODAL ── */}
      {editingMemory && (
        <EditModal
          memory={editingMemory}
          onSave={updateMemory}
          onClose={() => setEditingMemory(null)}
        />
      )}
    </div>
  );
}
