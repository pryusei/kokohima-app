import { DAY_MS, MINUTE_MS } from "./zonedTime";

// ここ暇の入力のルール（docs/specs/T-03-availability.md「入力」「決定事項」）

export const QUARTER_MS = 15 * MINUTE_MS;
export const MIN_LENGTH_MS = 30 * MINUTE_MS;
export const MAX_LENGTH_MS = DAY_MS;
export const HORIZON_MS = 60 * DAY_MS;
export const MAX_FUTURE_MANUAL = 100;
export const MAX_RULES = 20;

export type SlotProblem = "not_quarter" | "too_short" | "too_long" | "in_past" | "too_far";

/** 手動の枠（UTCの瞬間）を検証する */
export function checkManualSlot(startsAt: number, endsAt: number, now: number): SlotProblem | null {
  if (startsAt % QUARTER_MS !== 0 || endsAt % QUARTER_MS !== 0) return "not_quarter";
  if (endsAt - startsAt < MIN_LENGTH_MS) return "too_short";
  if (endsAt - startsAt > MAX_LENGTH_MS) return "too_long";
  if (endsAt <= now) return "in_past";
  if (startsAt - now > HORIZON_MS) return "too_far";
  return null;
}

/** 現地の開始・終了の分（プリセット・くり返し）を検証する。日をまたがない */
export function checkLocalRange(startMinute: number, endMinute: number): boolean {
  return (
    startMinute % 15 === 0 &&
    endMinute % 15 === 0 &&
    startMinute >= 0 &&
    startMinute <= 1425 &&
    endMinute <= 1440 &&
    endMinute - startMinute >= 30
  );
}

// ---- 今ひま（docs/specs/T-40-ima-hima.md） ----

/** 今ひまの長さ。日付をまたいでも切らない（22:10 に押すと 22:15〜翌 1:15） */
export const FREE_NOW_LENGTH_MS = 3 * 60 * MINUTE_MS;

/** 今ひまの枠の目印（availabilities.label に保存する値。友達に返す label には出さない） */
export const FREE_NOW_LABEL = "free_now";

/** 時刻を15分の区切りに切り上げる（ちょうど区切りならそのまま） */
export const ceilQuarter = (ms: number) => Math.ceil(ms / QUARTER_MS) * QUARTER_MS;

/**
 * 今ひまの枠を決める。開始は今を15分で切り上げた時刻、長さは3時間。
 * 開始を渡すのは「元に戻す」（やめた今ひまと同じ時刻で作り直す）だけで、
 * 15分の区切りで、今を切り上げた時刻以前、かつ終了が今より後でなければ null（先の時刻の今ひまは作らせない）
 */
export function freeNowSlot(now: number, startsAt?: number): { startsAt: number; endsAt: number } | null {
  const latest = ceilQuarter(now);
  const start = startsAt ?? latest;
  if (start % QUARTER_MS !== 0 || start > latest || start + FREE_NOW_LENGTH_MS <= now) return null;
  return { startsAt: start, endsAt: start + FREE_NOW_LENGTH_MS };
}
