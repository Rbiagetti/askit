"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { detectDuplicates, DuplicateCluster } from "@/lib/tfidf";
import { Memory, SearchResult } from "@/components/types";
import EditModal from "@/components/EditModal";
import MemoryCard from "@/components/MemoryCard";
import DuplicateModal from "@/components/DuplicateModal";

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<"add" | "search" | "calendar">("add");
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [autoSubmitLeft, setAutoSubmitLeft] = useState<number | null>(null); // ms left, null = inactive
  const [routedNotice, setRoutedNotice] = useState<string | null>(null); // raw text auto-routed to search
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
  // VAD (voice activity detection) refs — auto-stop on silence
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingStartRef = useRef(0);
  const baselineRef = useRef<number | null>(null);
  const baselineSamplesRef = useRef<number[]>([]);
  const silenceStartRef = useRef<number | null>(null);
  // Auto-submit countdown after voice transcription
  const autoSubmitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSubmitIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Refs mirroring state read inside async/timer callbacks, to avoid stale closures
  const modeRef = useRef(mode);
  const processingRef = useRef(processing);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { processingRef.current = processing; }, [processing]);

  // Stop any live VAD timer / AudioContext and auto-submit countdown on unmount.
  useEffect(() => {
    return () => {
      if (vadIntervalRef.current) clearInterval(vadIntervalRef.current);
      audioCtxRef.current?.close().catch(() => {});
      if (autoSubmitTimeoutRef.current) clearTimeout(autoSubmitTimeoutRef.current);
      if (autoSubmitIntervalRef.current) clearInterval(autoSubmitIntervalRef.current);
    };
  }, []);

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
  // `raw` is passed explicitly (rather than read from `input` state) so this can be
  // called safely from timers/callbacks (voice auto-submit) without stale closures.
  // A question ("intent: explore") gets routed to search by /api/parse instead of
  // creating a note — `opts.force` overrides that ("salva comunque come nota").
  const submitAdd = async (raw: string, opts: { force?: boolean; clearInput?: boolean } = {}) => {
    if (!raw.trim() || processingRef.current) return;
    setProcessing(true);
    if (opts.clearInput) setInput("");
    cancelAutoSubmit();
    try {
      const res = await fetch("/api/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: raw, ...(opts.force ? { force: "save" } : {}) }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.routed === "search") {
        setMode("search");
        setRoutedNotice(raw);
        setProcessing(false);
        await runSearch(raw);
        return;
      }

      setRoutedNotice(null);
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
      if (opts.clearInput) setInput(raw);
      showToast(`Errore: ${e instanceof Error ? e.message : "sconosciuto"}`, false);
    }
    setProcessing(false);
  };

  const addMemory = () => submitAdd(input, { clearInput: true });

  // User tapped "salva comunque come nota" on a note that got auto-routed to search.
  const forceSaveAsNote = async () => {
    if (!routedNotice) return;
    const raw = routedNotice;
    setRoutedNotice(null);
    await submitAdd(raw, { force: true });
    setMode("add");
    setSearchResult(null);
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
  // Auto-stop on silence: RMS over ~100ms windows, background noise sampled during
  // the first 500ms as baseline, 2s continuously below (baseline + margin) triggers
  // stopRecording(). Minimum recording length 1s regardless of silence.
  const VAD_WINDOW_MS = 100;
  const VAD_BASELINE_MS = 500;
  const VAD_MIN_RECORDING_MS = 1000;
  const VAD_SILENCE_MS = 2000;
  const VAD_MARGIN = 0.02;
  const AUTO_SUBMIT_MS = 4000;

  const stopVad = () => {
    if (vadIntervalRef.current) { clearInterval(vadIntervalRef.current); vadIntervalRef.current = null; }
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    baselineRef.current = null;
    baselineSamplesRef.current = [];
    silenceStartRef.current = null;
    setAudioLevel(0);
    setRecordingSeconds(0);
  };

  const cancelAutoSubmit = () => {
    if (autoSubmitTimeoutRef.current) { clearTimeout(autoSubmitTimeoutRef.current); autoSubmitTimeoutRef.current = null; }
    if (autoSubmitIntervalRef.current) { clearInterval(autoSubmitIntervalRef.current); autoSubmitIntervalRef.current = null; }
    setAutoSubmitLeft(null);
  };

  // Countdown after a voice transcription lands in the input; any interaction with
  // the input cancels it (see textarea handlers below). Routes like handleSubmit
  // would, using explicit `raw` text + modeRef to dodge the MediaRecorder callback's
  // stale closure over `input`/`mode`.
  const armAutoSubmit = (raw: string) => {
    cancelAutoSubmit();
    const deadline = Date.now() + AUTO_SUBMIT_MS;
    setAutoSubmitLeft(AUTO_SUBMIT_MS);
    autoSubmitIntervalRef.current = setInterval(() => {
      const left = deadline - Date.now();
      setAutoSubmitLeft(left > 0 ? left : 0);
    }, 100);
    autoSubmitTimeoutRef.current = setTimeout(() => {
      cancelAutoSubmit();
      if (modeRef.current === "search") submitSearch(raw);
      else submitAdd(raw, { clearInput: true });
    }, AUTO_SUBMIT_MS);
  };

  const startRecording = async () => {
    cancelAutoSubmit();
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
          if (d.text) {
            setInput(d.text);
            armAutoSubmit(d.text);
          }
        } catch { showToast("Errore trascrizione", false); }
        setProcessing(false);
      };
      mr.start();
      setRecording(true);

      // ── VAD setup ──
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const audioCtx = new AudioCtx();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        audioCtxRef.current = audioCtx;
        recordingStartRef.current = performance.now();
        baselineRef.current = null;
        baselineSamplesRef.current = [];
        silenceStartRef.current = null;

        const data = new Uint8Array(analyser.fftSize);
        vadIntervalRef.current = setInterval(() => {
          analyser.getByteTimeDomainData(data);
          let sumSq = 0;
          for (let i = 0; i < data.length; i++) {
            const v = (data[i] - 128) / 128;
            sumSq += v * v;
          }
          const rms = Math.sqrt(sumSq / data.length);
          setAudioLevel(rms);

          const elapsedMs = performance.now() - recordingStartRef.current;
          setRecordingSeconds(elapsedMs / 1000);

          if (elapsedMs < VAD_BASELINE_MS) {
            baselineSamplesRef.current.push(rms);
            return;
          }
          if (baselineRef.current === null) {
            const samples = baselineSamplesRef.current;
            baselineRef.current = samples.length
              ? samples.reduce((a, b) => a + b, 0) / samples.length
              : rms;
          }
          if (elapsedMs < VAD_MIN_RECORDING_MS) return;

          const threshold = baselineRef.current + VAD_MARGIN;
          if (rms < threshold) {
            if (silenceStartRef.current === null) silenceStartRef.current = performance.now();
            else if (performance.now() - silenceStartRef.current >= VAD_SILENCE_MS) {
              stopRecording();
            }
          } else {
            silenceStartRef.current = null;
          }
        }, VAD_WINDOW_MS);
      }
    } catch { showToast("Microfono non disponibile", false); }
  };

  const stopRecording = () => {
    stopVad();
    mediaRecorderRef.current?.stop();
    setRecording(false);
  };

  // POST /api/search + populate searchResult. Shared by manual search and the
  // auto-routing path (intent: explore) in submitAdd above.
  const runSearch = async (query: string) => {
    setProcessing(true);
    setSearchResult(null);
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

  // `query` passed explicitly for the same stale-closure reason as submitAdd.
  const submitSearch = async (query: string) => {
    if (!query.trim() || processingRef.current) return;
    setInput("");
    cancelAutoSubmit();
    await runSearch(query);
  };

  const executeSearch = () => submitSearch(input);

  const selectMode = (m: "add" | "search" | "calendar") => {
    setMode(m);
    setSearchResult(null);
    setRoutedNotice(null);
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
            {(["add", "search", "calendar"] as const).map((m) => (
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
                {m === "add" ? "+ Aggiungi" : m === "search" ? "🔍 Cerca" : "📅 Calendar"}
              </button>
            ))}
          </div>

          {/* Input row */}
          {mode !== "calendar" && <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => { cancelAutoSubmit(); setInput(e.target.value); }}
              onClick={cancelAutoSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit();
                else if (e.key === "Escape") cancelAutoSubmit();
              }}
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

          {/* Recording level + timer (VAD feedback) */}
          {recording && (
            <div className="flex items-center gap-2 fade-in">
              <span className="text-[10px] tracking-wider tabular-nums" style={{ color: "var(--red)" }}>
                ● {recordingSeconds.toFixed(1)}s
              </span>
              <div className="flex-1 h-1" style={{ background: "var(--border)" }}>
                <div
                  className="h-full"
                  style={{
                    width: `${Math.min(100, audioLevel * 400)}%`,
                    background: "var(--red)",
                    transition: "width 0.08s linear",
                  }}
                />
              </div>
            </div>
          )}

          {/* Auto-submit countdown after voice transcription */}
          {autoSubmitLeft !== null && (
            <div className="flex items-center gap-2 fade-in">
              <div className="flex-1 h-1" style={{ background: "var(--border)" }}>
                <div
                  className="h-full"
                  style={{
                    width: `${(autoSubmitLeft / AUTO_SUBMIT_MS) * 100}%`,
                    background: "var(--accent)",
                    transition: "width 0.1s linear",
                  }}
                />
              </div>
              <span className="text-[10px] tracking-wider tabular-nums" style={{ color: "var(--fg-muted)" }}>
                invio in {Math.ceil(autoSubmitLeft / 1000)}s
              </span>
              <button
                onClick={cancelAutoSubmit}
                className="text-[10px] uppercase tracking-wider"
                style={{ color: "var(--red)" }}
              >
                Annulla
              </button>
            </div>
          )}

          {/* Submit */}
          {mode !== "calendar" && <button
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
          {mode !== "calendar" && searchResult && (
            <div className="fade-in border-b border-[var(--border)] px-4 py-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-[10px] tracking-[0.15em] uppercase" style={{ color: "var(--fg-muted)" }}>
                  🔍 RISERCA SEMANTICA
                </p>
                <button
                  onClick={() => { setSearchResult(null); setRoutedNotice(null); }}
                  className="text-[10px] tracking-wider uppercase"
                  style={{ color: "var(--fg-muted)" }}
                >
                  × chiudi
                </button>
              </div>

              {/* Auto-routed from "add": this looked like a question, not a note */}
              {routedNotice && (
                <div
                  className="flex items-center justify-between gap-2 px-3 py-2 text-[10px]"
                  style={{ border: "1px solid var(--border)", color: "var(--fg-muted)" }}
                >
                  <span className="tracking-wider uppercase">interpretato come domanda</span>
                  <button
                    onClick={forceSaveAsNote}
                    className="uppercase tracking-wider whitespace-nowrap"
                    style={{ color: "var(--accent)" }}
                  >
                    salva comunque come nota
                  </button>
                </div>
              )}

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
          {mode !== "calendar" && !loaded ? (
            <div className="flex justify-center gap-2 py-16">
              <div className="glyph-dot" />
              <div className="glyph-dot" style={{ animationDelay: "0.4s" }} />
              <div className="glyph-dot" style={{ animationDelay: "0.8s" }} />
            </div>
          ) : mode !== "calendar" && memories.length === 0 ? (
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
          ) : mode !== "calendar" ? (
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
