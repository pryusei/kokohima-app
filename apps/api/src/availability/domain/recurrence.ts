import type { Label } from "./slots";
import { inRange } from "./slots";
import { addDays, localDateOf, localToUtc, weekdayOf } from "./zonedTime";

// くり返しの展開（docs/specs/T-03-availability.md「くり返し」）

export type RecurrenceRule = {
  id: string;
  weekday: number;
  startMinute: number;
  endMinute: number;
  label: Label | null;
  timezone: string;
  exceptions: ReadonlySet<string>;
};

export type ExpandedSlot = { ruleId: string; date: string; startsAt: number; endsAt: number; label: Label | null };

/**
 * UTCの範囲 [from, to) を、ルールのタイムゾーンでの日付に直し、前後1日を足した各日について展開する。
 * 範囲と1分以上重なり、終了が now より後の枠だけを返す
 */
export function expandRule(rule: RecurrenceRule, from: number, to: number, now: number): ExpandedSlot[] {
  const first = addDays(localDateOf(from, rule.timezone), -1);
  const last = addDays(localDateOf(to, rule.timezone), 1);
  const result: ExpandedSlot[] = [];
  for (let date = first; date <= last; date = addDays(date, 1)) {
    if (weekdayOf(date) !== rule.weekday || rule.exceptions.has(date)) continue;
    const startsAt = localToUtc(date, rule.startMinute, rule.timezone);
    const endsAt = localToUtc(date, rule.endMinute, rule.timezone);
    // 夏時間の切り替えで終了が開始以前になった枠は作らない
    if (endsAt <= startsAt) continue;
    const slot = { ruleId: rule.id, date, startsAt, endsAt, label: rule.label };
    if (endsAt > now && inRange(slot, from, to)) result.push(slot);
  }
  return result;
}
