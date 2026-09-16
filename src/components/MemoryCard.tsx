"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// Below this width, tap-and-hold competes with the OS's own text-selection
// gesture (the magnifier/selection-handles popup) — swipe left/right replaces
// it entirely instead of trying to out-time the OS. Above it (desktop-ish,
// mouse-driven), hover reveals the action bar, so this never matters there.
const MOBILE_BREAKPOINT = 640;

// Delete is destructive and irreversible, edit isn't — so they don't share a
// threshold. 60px (roughly a light flick) turned out to delete real notes by
// accident, reported by the user. Deleting now needs a swipe that travels
// most of the card's width and is held there at release — hard to do without
// meaning to, easy to do on purpose. Edit keeps the old, lighter threshold.
const DELETE_MAX_DRAG = 220;
const DELETE_ARM_THRESHOLD = 170;
const EDIT_MAX_DRAG = 100;
const EDIT_THRESHOLD = 60;
import { Memory } from "./types";

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

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return "adesso";
  if (d < 3600000) return `${Math.floor(d / 60000)}min fa`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h fa`;
  if (d < 604800000) return `${Math.floor(d / 86400000)}g fa`;
  return new Date(ts).toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
}

export default function MemoryCard({
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
  const [actionsOpen, setActionsOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const touchStart = useRef({ x: 0, y: 0 });
  const isHorizontal = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  const armedHaptic = useRef(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const doDelete = useCallback(() => {
    setActionsOpen(false);
    setLeaving(true);
    setTimeout(() => onDelete(memory.id), 250);
  }, [memory.id, onDelete]);

  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (!isTouchDevice) setIsTouchDevice(true);
    touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    isHorizontal.current = false;
    didLongPress.current = false;
    armedHaptic.current = false;

    // On narrow screens, tap-and-hold fights the OS's own text-selection
    // gesture — skip it entirely there, swipe both ways covers the same
    // two actions without the conflict.
    if (isMobile) return;

    longPressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      setActionsOpen(true);
      setSwipeX(0);
      if (navigator.vibrate) navigator.vibrate(12);
    }, 450);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const dx = e.touches[0].clientX - touchStart.current.x;
    const dy = e.touches[0].clientY - touchStart.current.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) cancelLongPress();
    if (!isHorizontal.current) {
      if (Math.abs(dy) > Math.abs(dx) + 5) {
        setActivelySwiping(false);
        return;
      }
      if (Math.abs(dx) > 8) isHorizontal.current = true;
    }
    if (isHorizontal.current && !actionsOpen) {
      // Desktop/tablet keeps the old swipe-left-only-to-delete behaviour
      // (right swipe there does nothing, hover already reveals both actions).
      // Mobile gets both directions: left deletes, right edits.
      if (dx < 0) {
        setActivelySwiping(true);
        const clamped = Math.max(dx, -DELETE_MAX_DRAG);
        setSwipeX(clamped);
        // One buzz the moment it crosses into "this will actually delete"
        // territory — confirms the commitment before release, not after.
        if (clamped <= -DELETE_ARM_THRESHOLD && !armedHaptic.current) {
          armedHaptic.current = true;
          if (navigator.vibrate) navigator.vibrate(15);
        } else if (clamped > -DELETE_ARM_THRESHOLD) {
          armedHaptic.current = false;
        }
      } else if (isMobile && dx > 0) {
        setActivelySwiping(true);
        setSwipeX(Math.min(dx, EDIT_MAX_DRAG));
      }
    }
  };

  const onTouchEnd = () => {
    cancelLongPress();
    setActivelySwiping(false);
    if (didLongPress.current) return;
    if (swipeX <= -DELETE_ARM_THRESHOLD) {
      doDelete();
    } else if (isMobile && swipeX > EDIT_THRESHOLD) {
      setSwipeX(0);
      onEdit(memory);
    } else {
      setSwipeX(0);
    }
  };

  const showActions = actionsOpen || (!isTouchDevice && hovered);
  const color = DOMAIN_COLOR[memory.domain] || DOMAIN_COLOR.general;
  const deleteArmed = swipeX <= -DELETE_ARM_THRESHOLD;
  const deleteProgress = Math.min(Math.abs(Math.min(swipeX, 0)) / DELETE_ARM_THRESHOLD, 1);
  const editProgress = Math.min(Math.max(swipeX, 0) / EDIT_THRESHOLD, 1);

  if (leaving) return <div style={{ maxHeight: 0, opacity: 0, overflow: "hidden", transition: "all 0.25s" }} />;

  return (
    <div className="relative overflow-hidden" style={{ marginBottom: 1 }}>
      {/* Swipe bg — left: delete (all screens), right: edit (mobile only) */}
      <div
        className="absolute inset-0 flex items-center justify-end pr-5"
        style={{
          background: `rgba(255,59,48,${deleteProgress * 0.9})`,
          visibility: swipeX < -8 ? "visible" : "hidden",
        }}
      >
        <span className="text-white text-[11px] tracking-widest uppercase font-mono">
          {deleteArmed ? "rilascia per eliminare" : "elimina"}
        </span>
      </div>
      {isMobile && (
        <div
          className="absolute inset-0 flex items-center justify-start pl-5"
          style={{
            background: `rgba(255,255,255,${editProgress * 0.14})`,
            visibility: swipeX > 8 ? "visible" : "hidden",
          }}
        >
          <span className="text-[11px] tracking-widest uppercase font-mono" style={{ color: "var(--fg)" }}>
            modifica
          </span>
        </div>
      )}

      {/* Card */}
      <div
        className="relative px-4 py-3"
        style={{
          background: showActions
            ? "rgba(255,255,255,0.04)"
            : highlight
            ? "rgba(255,255,255,0.03)"
            : "transparent",
          borderLeft: `2px solid ${showActions ? "rgba(255,255,255,0.2)" : highlight ? color : "transparent"}`,
          transform: `translateX(${swipeX}px)`,
          transition: activelySwiping ? "none" : "transform 0.22s ease, background 0.15s, border-color 0.15s",
          // Without this, a touch that starts moving horizontally still lets
          // iOS/Android arm their own text-selection (magnifier + selection
          // handles) mid-swipe, fighting our gesture. pan-y still allows the
          // page itself to scroll vertically over this card.
          ...(isMobile ? { touchAction: "pan-y", WebkitUserSelect: "none", userSelect: "none" } : {}),
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Top row */}
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span style={{ color, fontSize: 12 }}>{TYPE_ICONS[memory.type] || "○"}</span>
            <span
              className="text-[10px] px-1.5 py-0.5"
              style={{ background: color + "22", color, border: `1px solid ${color}44` }}
            >
              {memory.type}
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5"
              style={{
                background: "rgba(255,255,255,0.04)",
                color: "var(--fg-muted)",
                border: "1px solid var(--border)",
              }}
            >
              {memory.domain}
            </span>
            {memory.usageCount > 0 && (
              <span className="text-[10px]" style={{ color: "var(--fg-muted)" }}>
                · {memory.usageCount}×
              </span>
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
              <span
                key={i}
                className="text-[10px] px-1.5 py-0.5"
                style={{ background: "rgba(255,255,255,0.05)", color: "var(--fg-dim)" }}
              >
                #{e}
              </span>
            ))}
          </div>
        )}

        {/* Action bar — slides in on hover (desktop) or long press (mobile) */}
        <div
          style={{
            display: "grid",
            gridTemplateRows: showActions ? "1fr" : "0fr",
            transition: "grid-template-rows 0.2s ease",
          }}
        >
          <div className="overflow-hidden">
            <div className="flex gap-2 pt-2.5">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setActionsOpen(false);
                  onEdit(memory);
                }}
                className="flex-1 py-1.5 text-[11px] tracking-[0.12em] uppercase border transition-colors"
                style={{
                  borderColor: "var(--border)",
                  color: "var(--fg-muted)",
                  background: "rgba(255,255,255,0.04)",
                }}
              >
                ✎ Modifica
              </button>
              <button
                onTouchEnd={(e) => {
                  e.stopPropagation();
                  doDelete();
                }}
                onClick={doDelete}
                className="flex-1 py-1.5 text-[11px] tracking-[0.12em] uppercase border transition-colors"
                style={{ borderColor: "var(--red)", color: "var(--red)", background: "rgba(255,59,48,0.08)" }}
              >
                ✕ Elimina
              </button>
              {actionsOpen && (
                <button
                  onTouchEnd={(e) => {
                    e.stopPropagation();
                    setActionsOpen(false);
                  }}
                  onClick={() => setActionsOpen(false)}
                  className="px-3 py-1.5 text-[11px] border"
                  style={{ borderColor: "var(--border)", color: "var(--fg-muted)" }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
