// Time zone math and open-slot generation. Availability is stored in the coach's local time;
// everything else is UTC.

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function validTimeZone(tz: string): boolean {
  try { fmt(tz); return true; } catch { return false; }
}

/** Calendar parts of an instant as seen in a time zone. */
export function localParts(ms: number, tz: string) {
  const p: Record<string, string> = {};
  for (const part of fmt(tz).formatToParts(new Date(ms))) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

/** Offset of tz from UTC at an instant, in ms (e.g. -5h for Central Daylight Time). */
function offsetMs(ms: number, tz: string) {
  const p = localParts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of a local wall-clock time (date "YYYY-MM-DD" + minutes after midnight) in tz. */
export function zonedToUtc(date: string, minutes: number, tz: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, 0, minutes);
  let utc = wall - offsetMs(wall, tz);
  const second = wall - offsetMs(utc, tz);   // correct across a DST change
  if (second !== utc) utc = second;
  return utc;
}

/** Local date "YYYY-MM-DD" of an instant in tz. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export type SlotRules = {
  timezone: string; lesson_minutes: number; slot_step_minutes: number; buffer_minutes: number;
  min_notice_hours: number; max_days_ahead: number;
};
export type Window = { weekday: number; start_min: number; end_min: number };
export type Busy = { start: number; end: number };

/**
 * Open lesson start times (UTC ms) for local dates [fromDate, fromDate + days).
 * busy = other lessons and time off; lessons are padded by the buffer on both sides.
 */
export function openSlots(
  rules: SlotRules, windows: Window[], busy: Busy[], fromDate: string, days: number, now = Date.now(),
): number[] {
  const len = rules.lesson_minutes * 60_000;
  const earliest = now + rules.min_notice_hours * 3_600_000;
  const latest = now + rules.max_days_ahead * 86_400_000;
  const out: number[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    const wd = weekdayOf(date);
    for (const w of windows) {
      if (w.weekday !== wd) continue;
      for (let m = w.start_min; m + rules.lesson_minutes <= w.end_min; m += rules.slot_step_minutes) {
        const start = zonedToUtc(date, m, rules.timezone);
        const end = start + len;
        if (start < earliest || start > latest) continue;
        if (busy.some((b) => start < b.end && end > b.start)) continue;
        out.push(start);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
