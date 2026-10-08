// 現地の日付・時刻とUTCの変換（docs/specs/T-03-availability.md、api-conventions「日時とタイムゾーン」）
// Intl.DateTimeFormat だけを使う純粋な関数。D1・Hono・fetch は使わない

export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** その瞬間の、現地の暦の時刻を「UTCとみなしたミリ秒」で返す */
function localWallClock(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/** その瞬間の、UTCからのずれ（現地 − UTC、ミリ秒） */
function offsetAt(instant: number, timeZone: string): number {
  return localWallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** "YYYY-MM-DD" → その日の0時を「UTCとみなしたミリ秒」 */
export function parseLocalDate(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return formatLocalDate(ms) === date ? ms : null;
}

function formatLocalDate(utcMidnight: number): string {
  return new Date(utcMidnight).toISOString().slice(0, 10);
}

/**
 * 現地の日付と0時からの分（0〜1440）を、UTCの瞬間に変換する。
 * 存在しない時刻（時計が進む日）は、ずれた分だけ後ろにずらす。
 * 二重に存在する時刻（時計が戻る日）は、早いほうを使う（Temporal の disambiguation: "compatible"）
 */
export function localToUtc(date: string, minutes: number, timeZone: string): number {
  const day = parseLocalDate(date);
  if (day === null) throw new Error("invalid date");
  const wall = day + minutes * MINUTE_MS;
  const before = offsetAt(wall - DAY_MS, timeZone);
  const after = offsetAt(wall + DAY_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((instant) => localWallClock(instant, timeZone) === wall)
    .sort((a, b) => a - b);
  if (candidates[0] !== undefined) return candidates[0];
  // 存在しない時刻：切り替え前のずれで計算すると、ずれた分だけ後ろの時刻になる
  return wall - before;
}

/** その瞬間の、現地の日付 "YYYY-MM-DD" */
export function localDateOf(instant: number, timeZone: string): string {
  return formatLocalDate(Math.floor(localWallClock(instant, timeZone) / DAY_MS) * DAY_MS);
}

/** 日付に日数を足す */
export function addDays(date: string, days: number): string {
  const day = parseLocalDate(date);
  if (day === null) throw new Error("invalid date");
  return formatLocalDate(day + days * DAY_MS);
}

/** 曜日（0＝日〜6＝土） */
export function weekdayOf(date: string): number {
  const day = parseLocalDate(date);
  if (day === null) throw new Error("invalid date");
  return new Date(day).getUTCDay();
}

/** "HH:MM" ↔ 0時からの分。終了には "24:00"（1440）を使える */
export function parseHhmm(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (Number(m[2]) >= 60 || minutes > 1440) return null;
  return minutes;
}

export function formatHhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
