"use client";

import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        // full navigation, so the new cookie is sent with the very first request
        window.location.href = "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Accesso non riuscito");
    } catch {
      setError("Errore di rete");
    }
    setBusy(false);
  };

  return (
    <div className="dot-grid flex w-full flex-1 items-center justify-center" style={{ minHeight: "100dvh" }}>
      <form onSubmit={submit} className="w-full max-w-xs px-4 space-y-3">
        <div className="flex items-center gap-2 pb-2">
          <div className="flex gap-1">
            <div className="glyph-dot" />
            <div className="glyph-dot" style={{ animationDelay: "0.3s" }} />
            <div className="glyph-dot" style={{ animationDelay: "0.6s" }} />
          </div>
          <span className="text-[11px] tracking-[0.2em] uppercase" style={{ color: "var(--accent)" }}>
            Ask It
          </span>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          autoFocus
          // 16px minimo: sotto questa soglia iOS Safari zooma la pagina al focus
          className="w-full text-[16px] focus:outline-none"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--border-focus)",
            color: "var(--fg)",
            fontFamily: "inherit",
            padding: "9px 12px",
          }}
        />
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full py-2 text-[11px] tracking-[0.15em] uppercase transition-all disabled:opacity-25"
          style={{ background: "var(--fg)", color: "var(--bg)" }}
        >
          {busy ? "..." : "Entra"}
        </button>
        {error && (
          <p className="text-[11px] fade-in" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
