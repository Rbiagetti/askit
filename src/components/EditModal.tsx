"use client";

import { useState } from "react";
import { Memory } from "./types";

export default function EditModal({
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
            // 16px minimo: sotto questa soglia iOS Safari zooma la pagina al
            // focus dell'input, e lo zoom resta anche dopo aver chiuso il modale.
            className="w-full resize-none text-[16px] focus:outline-none"
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
