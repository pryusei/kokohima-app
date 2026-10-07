import { MINUTE_MS } from "./zonedTime";

// 枠の重なり・まとめ・並べ替え（docs/specs/T-03-availability.md「友達のここ暇」）

export type Label = "day" | "evening" | "night";

export type Slot = { startsAt: number; endsAt: number; label: Label | null };

/** 1分以上重なるか */
export function overlaps(a: { startsAt: number; endsAt: number }, b: { startsAt: number; endsAt: number }): boolean {
  return Math.min(a.endsAt, b.endsAt) - Math.max(a.startsAt, b.startsAt) >= MINUTE_MS;
}

/** 範囲 [from, to) と1分以上重なるか */
export function inRange(slot: { startsAt: number; endsAt: number }, from: number, to: number): boolean {
  return overlaps(slot, { startsAt: from, endsAt: to });
}

/** 重なる・接する枠を1つにまとめる。label は元がすべて同じならその値、違えば null */
export function mergeSlots(slots: Slot[]): Slot[] {
  const sorted = [...slots].sort((a, b) => a.startsAt - b.startsAt || a.endsAt - b.endsAt);
  const merged: Slot[] = [];
  for (const slot of sorted) {
    const last = merged.at(-1);
    if (last && slot.startsAt <= last.endsAt) {
      last.endsAt = Math.max(last.endsAt, slot.endsAt);
      if (last.label !== slot.label) last.label = null;
    } else {
      merged.push({ ...slot });
    }
  }
  return merged;
}

export type FriendSlot = Slot & { friendId: string; overlapsMine: boolean };

/**
 * 友達ごとにまとめ、自分の枠との重なりを付け、開始日時→友達のIDの順に並べる
 * （「みんな」の処理の順番の3と4）
 */
export function buildFriendSlots(byFriend: Map<string, Slot[]>, mine: Slot[]): FriendSlot[] {
  const result: FriendSlot[] = [];
  for (const [friendId, slots] of byFriend) {
    for (const slot of mergeSlots(slots)) {
      result.push({ ...slot, friendId, overlapsMine: mine.some((m) => overlaps(m, slot)) });
    }
  }
  return result.sort((a, b) => a.startsAt - b.startsAt || (a.friendId < b.friendId ? -1 : a.friendId > b.friendId ? 1 : 0));
}

/** カーソル（直前のページの最後の枠の開始日時と友達のID）の後ろから limit 件を切り出す */
export function pageAfter<T extends { startsAt: number; friendId: string }>(
  sorted: T[],
  cursor: { k: number; id: string } | null,
  limit: number,
): { items: T[]; next: { k: number; id: string } | null } {
  const start = cursor
    ? sorted.findIndex((s) => s.startsAt > cursor.k || (s.startsAt === cursor.k && s.friendId > cursor.id))
    : 0;
  if (start === -1) return { items: [], next: null };
  const items = sorted.slice(start, start + limit);
  const last = items.at(-1);
  return { items, next: start + limit < sorted.length && last ? { k: last.startsAt, id: last.friendId } : null };
}
