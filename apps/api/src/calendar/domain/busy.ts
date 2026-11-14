// 埋まりの区間の計算（docs/specs/T-06-calendar.md「定期の確認と自動取り消し」）。予定の中身は持たず、時刻だけを扱う

export type Interval = { startsAt: number; endsAt: number };

const MINUTE_MS = 60 * 1000;

/** 開始の順に並べ、重なる・接する区間をつなぐ。長さのない区間は捨てる */
export function normalize(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.endsAt > i.startsAt).sort((a, b) => a.startsAt - b.startsAt);
  const result: Interval[] = [];
  for (const i of sorted) {
    const last = result.at(-1);
    if (last && i.startsAt <= last.endsAt) last.endsAt = Math.max(last.endsAt, i.endsAt);
    else result.push({ startsAt: i.startsAt, endsAt: i.endsAt });
  }
  return result;
}

/** a から b を引いた部分 */
export function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const minus = normalize(b);
  const result: Interval[] = [];
  for (const i of normalize(a)) {
    let start = i.startsAt;
    for (const m of minus) {
      if (m.endsAt <= start || m.startsAt >= i.endsAt) continue;
      if (m.startsAt > start) result.push({ startsAt: start, endsAt: m.startsAt });
      start = Math.max(start, m.endsAt);
      if (start >= i.endsAt) break;
    }
    if (start < i.endsAt) result.push({ startsAt: start, endsAt: i.endsAt });
  }
  return result;
}

/** [from, to) に入る部分だけを残す */
export function clip(intervals: readonly Interval[], from: number, to: number): Interval[] {
  return normalize(
    intervals.map((i) => ({ startsAt: Math.max(i.startsAt, from), endsAt: Math.min(i.endsAt, to) })),
  );
}

/**
 * 新しく入った埋まり＝今回の埋まりから前回の埋まりを引き、前回の範囲 [prevFrom, prevTo) に入る部分。
 * 前回の範囲の外（範囲がずれて新しく見えるようになった先の日付）は、新しく入ったものとして扱わない
 */
export function newlyBusy(
  previous: { busy: readonly Interval[]; from: number; to: number },
  current: readonly Interval[],
): Interval[] {
  return clip(subtract(current, previous.busy), previous.from, previous.to);
}

/** 1分以上重なるか（T-03 と同じ重なりの定義） */
export function overlapsAny(slot: Interval, intervals: readonly Interval[]): boolean {
  return intervals.some((i) => Math.min(i.endsAt, slot.endsAt) - Math.max(i.startsAt, slot.startsAt) >= MINUTE_MS);
}

/** 保存の形（[[開始, 終了], ...] の JSON）。時刻以外は入れない */
export function encodeBusy(intervals: readonly Interval[]): string {
  return JSON.stringify(normalize(intervals).map((i) => [i.startsAt, i.endsAt]));
}

export function decodeBusy(json: string): Interval[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) return [];
  return normalize(
    parsed.flatMap((p) =>
      Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number" ? [{ startsAt: p[0], endsAt: p[1] }] : [],
    ),
  );
}
