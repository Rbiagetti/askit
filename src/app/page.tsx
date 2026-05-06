"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { rankByRelevance, detectDuplicates, DuplicateCluster } from "@/lib/tfidf";

interface Memory {
  id: string;
  text: string;
  content: string;
  type: string;
  domain: string;
  entities: string[];
  timestamp: number;
  usageCount: number;
}

interface AskResult {
  question: string;
  response: string;
  relevantIds: string[];
}

const TYPE_ICONS: Record<string, string> = {
  note: "○", task: "◇", wishlist: "☆", idea: "◈", reminder: "◎",
};

const DOMAIN_COLOR: Record<string, string> = {
  food: "#ff9f43", travel: "#54a0ff", work: "#a29bfe",
  health: "#00cec9", cinema: "#fd79a8", tech: "#74b9ff",
  music: "#b2bec3", learning: "#55efc4", shopping: "#fdcb6e",
  finance: "#ff7675", pets: "#81ecec", general: "#636e72",
};

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return "adesso";
  if (d < 3600000) return `${Math.floor(d / 60000)}min fa`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h fa`;
  if (d < 604800000) return `${Math.floor(d / 86400000)}g fa`;
  return new Date(ts).toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
}

// ─── Edit Modal ──────────────────────────────────────────────────────────────

function EditModal({
  memory,
  onSave,
  onClose,
}: {
  memory: Memory;
  onSave: (id: string, text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState(memory.text || memory.content);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    await onSave(memory.id, text.trim());
    setSaving(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      style={{ background: "rgba(0,0,0,0.88)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full max-w-lg mx-4 mb-4 sm:mb-0"
        style={{ background: "#0a0a0a", border: "1px solid var(--border)" }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
          <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "var(--accent)" }}>
            Modifica memoria
          </span>
          <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--fg-muted)" }}>×</button>
        </div>
        <div className="px-5 py-4 space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoFocus
            className="w-full resize-none text-sm focus:outline-none"
            style={{
              background: "var(--bg-input)",
              border: "1px solid var(--border-focus)",
              color: "var(--fg)",
              fontFamily: "inherit",
              padding: "10px 12px",
            }}
          />
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving || !text.trim()}
              className="flex-1 py-2 text-[11px] tracking-[0.15em] uppercase transition-all disabled:opacity-30"
              style={{ background: "var(--fg)", color: "var(--bg)" }}
            >
              {saving ? "Salvo..." : "Salva"}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 text-[11px] tracking-[0.15em] uppercase border"
              style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
            >
              Annulla
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Memory Card ─────────────────────────────────────────────────────────────

function MemoryCard({
  memory,
  onDelete,
  onEdit,
  highlight = false,
}: {
  memory: Memory;
  onDelete: (id: string) => void;
  onEdit: (memory: Memory) => void;
  highlight?: boolean;
}) {
  const [swipeX, setSwipeX] = useState(0);
  const [activelySwiping, setActivelySwiping] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const touchStart = useRef({ x: 0, y: 0 });
  const isHorizontal = useRef(false);

  const doDelete = useCallback(() => {
    setLeaving(true);
    setTimeout(() => onDelete(memory.id), 250);
  }, [memory.id, onDelete]);

  const onTouchStart = (e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    isHorizontal.current = false;
    setActivelySwiping(true);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    if (!isHorizontal.current) {
      if (Math.abs(dy) > Math.abs(dx) + 5) { setActivelySwiping(false); return; }
      if (Math.abs(dx) > 8) isHorizontal.current = true;
    }
    if (isHorizontal.current && dx < 0) setSwipeX(Math.max(dx, -100));
  };

  const onTouchEnd = () => {
    setActivelySwiping(false);
    if (swipeX < -60) doDelete();
    else setSwipeX(0);
  };

  const color = DOMAIN_COLOR[memory.domain] || DOMAIN_COLOR.general;
  const swipeProgress = Math.min(Math.abs(swipeX) / 60, 1);

  if (leaving) return <div style={{ maxHeight: 0, opacity: 0, overflow: "hidden", transition: "all 0.25s" }} />;

  return (
    <div
      className="relative overflow-hidden"
      style={{ marginBottom: 1 }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Swipe delete bg — hidden unless swiping */}
      <div
        className="absolute inset-0 flex items-center justify-end pr-5"
        style={{
          background: `rgba(255,59,48,${swipeProgress * 0.9})`,
          visibility: swipeX < -8 ? "visible" : "hidden",
        }}
      >
        <span className="text-white text-[11px] tracking-widest uppercase font-mono">elimina</span>
      </div>

      {/* Card */}
      <div
        className="relative group px-4 py-3"
        style={{
          background: highlight ? "rgba(255,255,255,0.03)" : "transparent",
          borderLeft: `2px solid ${highlight ? color : "transparent"}`,
          transform: `translateX(${swipeX}px)`,
          transition: activelySwiping ? "none" : "transform 0.22s ease",
        }}
      >
        {/* Top row */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span style={{ color, fontSize: 12 }}>{TYPE_ICONS[memory.type] || "○"}</span>
            <span className="text-[10px] px-1.5 py-0.5" style={{ background: color + "22", color, border: `1px solid ${color}44` }}>
              {memory.type}
            </span>
            <span className="text-[10px] px-1.5 py-0.5" style={{ background: "rgba(255,255,255,0.04)", color: "var(--fg-muted)", border: "1px solid var(--border)" }}>
              {memory.domain}
            </span>
            {memory.usageCount > 0 && (
              <span className="text-[10px]" style={{ color: "var(--fg-muted)" }}>· {memory.usageCount}×</span>
            )}
          </div>
          <span className="text-[10px] shrink-0" style={{ color: "var(--fg-muted)" }}>
            {relTime(memory.timestamp)}
          </span>
        </div>

        {/* Content */}
        <p className="text-sm leading-snug" style={{ color: "var(--accent)" }}>
          {memory.content || memory.text}
        </p>

        {/* Entities */}
        {memory.entities.length > 0 && (
          <div className="flex gap-1 mt-1.5 flex-wrap">
            {memory.entities.map((e, i) => (
              <span key={i} className="text-[10px] px-1.5 py-0.5" style={{ background: "rgba(255,255,255,0.05)", color: "var(--fg-dim)" }}>
                #{e}
              </span>
            ))}
          </div>
        )}

        {/* Hover actions — bottom right */}
        <div className="flex justify-end gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEdit(memory)}
            className="text-[10px] px-2 py-0.5 border tracking-wide"
            style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
          >
            ✎ Modifica
          </button>
          <button
            onClick={doDelete}
            className="text-[10px] px-2 py-0.5 border tracking-wide"
            style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(255,59,48,0.08)" }}
          >
            ✕ Elimina
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Duplicate Modal ──────────────────────────────────────────────────────────

function DuplicateModal({
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
        style={{ background: "#0a0a0a", border: "1px solid var(--border)", maxHeight: "80vh", display: "flex", flexDirection: "column" }}
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
          <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--fg-muted)" }}>×</button>
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
                        border: `1px solid ${id === cluster.representative ? "rgba(255,255,255,0.15)" : "var(--border)"}`,
                        color: id === cluster.representative ? "var(--accent)" : "var(--fg-dim)",
                      }}
                    >
                      {id === cluster.representative && (
                        <span className="mr-2 text-[10px]" style={{ color: "var(--green)" }}>★</span>
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

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"add" | "ask">("add");
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [askResult, setAskResult] = useState<AskResult | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [dupClusters, setDupClusters] = useState<DuplicateCluster[]>([]);
  const [showDup, setShowDup] = useState(false);
  const [editingMemory, setEditingMemory] = useState<Memory | null>(null);
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
    if (tok) setTotalTokens(parseInt(tok));
  }, []);

  useEffect(() => {
    localStorage.setItem("sb_tokens", String(totalTokens));
  }, [totalTokens]);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
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
      };
      setMemories((prev) => [newMem, ...prev]);
      showToast(`${data.type} · ${data.domain}`);
    } catch (e) {
      setInput(raw);
      showToast(`Errore: ${e instanceof Error ? e.message : "sconosciuto"}`, false);
    }
    setProcessing(false);
  };

  // ── Ask ──
  const askQuestion = async () => {
    if (!input.trim() || processing) return;
    setProcessing(true);
    setAskResult(null);
    const question = input;
    setInput("");

    const ranked = rankByRelevance(question, memories.map((m) => ({ id: m.id, text: m.content || m.text })));
    const topIds = ranked.slice(0, 10).filter((r) => r.score > 0.02).map((r) => r.id);
    const relevant = memories.filter((m) => topIds.includes(m.id));

    // Increment usageCount in SQLite (fire and forget)
    topIds.forEach((id) => {
      fetch("/api/items", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    });
    setMemories((prev) => prev.map((m) => topIds.includes(m.id) ? { ...m, usageCount: m.usageCount + 1 } : m));

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          memories: relevant.map((m) => ({ id: m.id, text: m.content || m.text })),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setTotalTokens((t) => t + (data.tokensUsed || 0));
      setAskResult({ question, response: data.response, relevantIds: topIds });
    } catch (e) {
      showToast(`Errore: ${e instanceof Error ? e.message : "sconosciuto"}`, false);
    }
    setProcessing(false);
  };

  // ── Delete → SQLite ──
  const deleteMemory = useCallback((id: string) => {
    setMemories((prev) => prev.filter((m) => m.id !== id));
    setAskResult((prev) => prev ? { ...prev, relevantIds: prev.relevantIds.filter((r) => r !== id) } : null);
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
          ? { ...m, text, content: data.content, type: data.type, domain: data.domain, entities: data.entities }
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

  const handleSubmit = () => mode === "add" ? addMemory() : askQuestion();

  const relevantMems = askResult ? memories.filter((m) => askResult.relevantIds.includes(m.id)) : [];

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
            {(["add", "ask"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className="text-[10px] tracking-[0.15em] uppercase px-3 py-1 transition-all"
                style={{
                  background: mode === m ? "var(--fg)" : "transparent",
                  color: mode === m ? "var(--bg)" : "var(--fg-muted)",
                  border: mode === m ? "1px solid var(--fg)" : "1px solid var(--border)",
                }}
              >
                {m === "add" ? "+ Aggiungi" : "? Domanda"}
              </button>
            ))}
          </div>

          {/* Input row */}
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(); }}
              placeholder={mode === "add" ? "Scrivi o detta qualcosa da ricordare..." : "Fai una domanda alle tue memorie..."}
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
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={processing || !input.trim()}
            className="w-full py-2 text-[11px] tracking-[0.15em] uppercase transition-all disabled:opacity-25"
            style={{ background: "var(--fg)", color: "var(--bg)" }}
          >
            {processing ? "..." : mode === "add" ? "Salva memoria  ⌘↵" : "Chiedi  ⌘↵"}
          </button>
        </div>
      </header>

      {/* ── SCROLLABLE BODY ── */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto">

          {/* Ask result block */}
          {askResult && (
            <div className="fade-in border-b border-[var(--border)] px-4 py-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                  ◎ risposta
                </p>
                <button
                  onClick={() => setAskResult(null)}
                  className="text-[10px] tracking-wider uppercase"
                  style={{ color: "var(--fg-muted)" }}
                >
                  × chiudi
                </button>
              </div>

              <div
                className="px-4 py-3 text-sm leading-relaxed"
                style={{ background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--accent)" }}
              >
                <p className="text-[10px] mb-2 italic" style={{ color: "var(--fg-dim)" }}>
                  «{askResult.question}»
                </p>
                {askResult.response}
              </div>

              {relevantMems.length > 0 && (
                <div>
                  <p className="text-[10px] tracking-[0.12em] uppercase mb-1 px-1" style={{ color: "var(--fg-muted)" }}>
                    Memorie usate ({relevantMems.length})
                  </p>
                  {relevantMems.map((m) => (
                    <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} onEdit={setEditingMemory} highlight />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Memory list */}
          {!loaded ? (
            <div className="flex justify-center gap-2 py-16">
              <div className="glyph-dot" />
              <div className="glyph-dot" style={{ animationDelay: "0.4s" }} />
              <div className="glyph-dot" style={{ animationDelay: "0.8s" }} />
            </div>
          ) : memories.length === 0 ? (
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
          ) : (
            <div className="pt-2 pb-4">
              {memories.map((m) => (
                <MemoryCard key={m.id} memory={m} onDelete={deleteMemory} onEdit={setEditingMemory} />
              ))}
            </div>
          )}
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
