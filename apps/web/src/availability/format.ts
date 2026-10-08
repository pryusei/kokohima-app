import type { PresetName } from "@kokohima/shared";

// ここ暇の表示（docs/specs/T-03-availability.md「画面」）
// 表示は閲覧者のタイムゾーンで行う。タイムゾーンの変更はスコープ外で、全員 Asia/Tokyo（夏時間なし）
// TODO(タイムゾーンの変更): サーバーは users.timezone で計算する。変更を入れるときは、閲覧者のタイムゾーンを
// API から受け取り、+09:00 の固定（localInstant・startOfLocalDay）を夏時間に対応した変換に作り直す

export const TIME_ZONE = "Asia/Tokyo";
const OFFSET = "+09:00";
const DAY_MS = 24 * 60 * 60 * 1000;

export const PRESET_LABELS: Record<PresetName, string> = { day: "昼", evening: "夕方", night: "夜" };
export const PRESET_NAMES: PresetName[] = ["day", "evening", "night"];
export const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** 瞬間 → 現地の日付（YYYY-MM-DD） */
export const localDateOf = (instant: number | string) => dateFormat.format(new Date(instant));

/** 現地の日付の 0:00 の瞬間 */
export const startOfLocalDay = (date: string) => Date.parse(`${date}T00:00:00${OFFSET}`);

/** 現地の日付＋時刻（HH:MM）の瞬間 */
export const localInstant = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00${OFFSET}`);

export function addDays(date: string, days: number) {
  return localDateOf(startOfLocalDay(date) + days * DAY_MS + DAY_MS / 2);
}

/** 今日から days 日分の範囲（UTCのISO） */
export function rangeFrom(today: string, days: number) {
  return { from: new Date(startOfLocalDay(today)).toISOString(), to: new Date(startOfLocalDay(addDays(today, days))).toISOString() };
}

/** 「10/10（土）」 */
export function formatDate(date: string) {
  const [, m, d] = date.split("-").map(Number);
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${m}/${d}（${weekday}）`;
}

/** 瞬間 → 現地の時刻（HH:MM） */
export const formatTime = (instant: string | number) => timeFormat.format(new Date(instant));

/** 「夜 19:00〜23:00」。プリセット名がなければ時刻だけ。終了が翌日の 0:00 なら 24:00、それ以外で日をまたぐなら日付を添える */
export function formatSlot(slot: { startsAt: string; endsAt: string; label: PresetName | null }) {
  const startDate = localDateOf(slot.startsAt);
  const endDate = localDateOf(slot.endsAt);
  let end = formatTime(slot.endsAt);
  if (endDate !== startDate) {
    end = end === "00:00" && endDate === addDays(startDate, 1) ? "24:00" : `${formatDate(endDate)} ${end}`;
  }
  const time = `${formatTime(slot.startsAt)}〜${end}`;
  return slot.label ? `${PRESET_LABELS[slot.label]} ${time}` : time;
}
