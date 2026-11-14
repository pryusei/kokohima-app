import { overlaps } from "./slots";

// カレンダーの実予定による自動取り消しの対象の選び方（docs/specs/T-06-calendar.md「定期の確認と自動取り消し」の手順5）

export type CancelCandidate<T> = T & { startsAt: number; endsAt: number; createdAt: number };

/**
 * 次の3つをすべて満たす枠：終了が現在より後、前回の確認より前に作った（createdAt < createdBefore）、
 * 新しく入った埋まりと1分以上重なる
 */
export function selectForCancel<T>(
  items: readonly CancelCandidate<T>[],
  newBusy: readonly { startsAt: number; endsAt: number }[],
  createdBefore: number,
  now: number,
): CancelCandidate<T>[] {
  if (newBusy.length === 0) return [];
  return items.filter(
    (item) => item.endsAt > now && item.createdAt < createdBefore && newBusy.some((b) => overlaps(item, b)),
  );
}
