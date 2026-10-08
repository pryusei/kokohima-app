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
