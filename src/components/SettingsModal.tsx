"use client";

import { useEffect, useRef, useState } from "react";

const FALLBACK = "general";

export default function SettingsModal({
  onClose,
  onToast,
}: {
  onClose: () => void;
  onToast: (msg: string, ok: boolean) => void;
}) {
  const [domains, setDomains] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // The parent recreates onToast on every render; depending on it directly would
  // re-run the fetch below and overwrite whatever the user is in the middle of editing.
  const toastRef = useRef(onToast);
  useEffect(() => {
    toastRef.current = onToast;
  }, [onToast]);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        setDomains(d.domains || []);
        setDefaults(d.defaults || []);
      })
      .catch(() => toastRef.current("Impossibile caricare le impostazioni", false))
      .finally(() => setLoading(false));
  }, []);

  const add = () => {
    const d = draft
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, 24);
    if (!d || domains.includes(d)) {
      setDraft("");
      return;
    }
    // keep the fallback last
    setDomains((prev) => [...prev.filter((x) => x !== FALLBACK), d, FALLBACK]);
    setDraft("");
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domains }),
      });
      if (!res.ok) throw new Error();
      toastRef.current("Domini salvati", true);
      onClose();
    } catch {
      toastRef.current("Salvataggio non riuscito", false);
    }
    setSaving(false);
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
            Impostazioni · Domini
          </span>
          <button onClick={onClose} className="text-lg leading-none" style={{ color: "var(--fg-muted)" }}>×</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--fg-dim)" }}>
            L&apos;AI assegna ogni nota a uno di questi domini e non ne inventa altri. Cambiare la lista
            vale per le note nuove; quelle già salvate restano come sono.
          </p>

          {loading ? (
            <div className="flex justify-center gap-2 py-6">
              <div className="glyph-dot" />
              <div className="glyph-dot" style={{ animationDelay: "0.3s" }} />
              <div className="glyph-dot" style={{ animationDelay: "0.6s" }} />
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {domains.map((d) => (
                <span
                  key={d}
                  className="flex items-center gap-1.5 text-[11px] px-2 py-1"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid var(--border)", color: "var(--accent)" }}
                >
                  {d}
                  {d === FALLBACK ? (
                    <span title="Dominio di riserva, non rimovibile" style={{ color: "var(--fg-muted)" }}>🔒</span>
                  ) : (
                    <button
                      onClick={() => setDomains((prev) => prev.filter((x) => x !== d))}
                      aria-label={`Rimuovi ${d}`}
                      className="leading-none px-0.5"
                      style={{ color: "var(--fg-dim)" }}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
              placeholder="nuovo dominio…"
              maxLength={24}
              // 16px minimo: sotto questa soglia iOS Safari zooma la pagina al focus
              className="flex-1 text-[16px] focus:outline-none"
              style={{
                background: "var(--bg-input)",
                border: "1px solid var(--border-focus)",
                color: "var(--fg)",
                fontFamily: "inherit",
                padding: "8px 12px",
              }}
            />
            <button
              onClick={add}
              disabled={!draft.trim()}
              className="px-4 text-[11px] tracking-[0.15em] uppercase border disabled:opacity-30"
              style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
            >
              Aggiungi
            </button>
          </div>

          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving || loading}
              className="flex-1 py-2 text-[11px] tracking-[0.15em] uppercase transition-all disabled:opacity-30"
              style={{ background: "var(--fg)", color: "var(--bg)" }}
            >
              {saving ? "Salvo..." : "Salva"}
            </button>
            <button
              onClick={() => setDomains(defaults)}
              disabled={loading}
              className="px-4 py-2 text-[11px] tracking-[0.15em] uppercase border disabled:opacity-30"
              style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
            >
              Predefiniti
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
