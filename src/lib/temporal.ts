/**
 * Temporal context for the prompts.
 *
 * Two separate needs, both previously unmet:
 *  - the model must know what "today" is, or relative expressions are unresolvable
 *  - it must know whether each note's date is past or future WITHOUT doing the
 *    arithmetic itself, which it gets wrong. We compute it here and state it.
 */

export const TIMEZONE = process.env.ASKIT_TIMEZONE || "Europe/Rome";

/** "Current datetime" block prepended to a prompt. */
export function temporalContext(now: Date): string {
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: TIMEZONE,
  }).format(now);
  const local = new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: TIMEZONE,
  }).format(now);
  return `Current datetime: ${local} (${weekday}, timezone ${TIMEZONE})\nISO: ${now.toISOString()}`;
}

const DAY_MS = 86_400_000;

/** Calendar days between two instants, in the configured timezone. */
function daysBetween(from: Date, to: Date): number {
  const key = (d: Date) =>
    new Intl.DateTimeFormat("sv-SE", { dateStyle: "short", timeZone: TIMEZONE }).format(d);
  return Math.round((Date.parse(key(to)) - Date.parse(key(from))) / DAY_MS);
}

/**
 * Human-readable, unambiguous position of a note's date relative to now —
 * e.g. "2026-08-01, PASSATO, 42 giorni fa" or "2026-09-30, FUTURO, fra 18 giorni".
 *
 * Stating PASSATO/FUTURO explicitly is the point: asked for "eventi a breve termine"
 * the model was calling an August date a future event in September.
 */
export function describeWhen(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;

  const date = new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "short",
    timeZone: TIMEZONE,
  }).format(when);
  const delta = daysBetween(now, when);

  if (delta === 0) return `${date}, OGGI`;
  if (delta === 1) return `${date}, FUTURO, domani`;
  if (delta === -1) return `${date}, PASSATO, ieri`;
  if (delta > 0) return `${date}, FUTURO, fra ${delta} giorni`;
  return `${date}, PASSATO, ${Math.abs(delta)} giorni fa`;
}
