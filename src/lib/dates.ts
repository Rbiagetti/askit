/**
 * SQLite's datetime('now') stores UTC as "YYYY-MM-DD HH:MM:SS" — no zone marker.
 * `new Date()` reads a marker-less string as LOCAL time, so a note created at 17:08
 * in Italy (15:08 UTC) showed up as "15:08", and "2h ago" right after creating it.
 * It stayed invisible on Vercel, whose servers run in UTC, but the detail view
 * parses this string in the browser, so it was wrong on real devices too.
 *
 * Strings that already carry a zone (ISO with "Z" or an offset, like time_ref) pass
 * through untouched.
 */
export function parseDbDate(value: string): Date {
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return new Date(hasZone ? value : value.replace(" ", "T") + "Z");
}
