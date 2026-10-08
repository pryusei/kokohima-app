import {
  friendAvailabilityPageSchema,
  myAvailabilityListSchema,
  presetsSchema,
  recurrenceRuleListSchema,
  slotListSchema,
  type FriendAvailability,
} from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";
import { localDateOf, rangeFrom } from "./format";

// ここ暇の取得（data-fetching スキル：キーは keys.ts の工場から）

export const today = () => localDateOf(Date.now());

const query = (range: { from: string; to: string }) =>
  `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;

/** 「みんな」：今日から7日分。続きがあれば最後まで読む（黙って切らない） */
export const everyoneQuery = (date: string) => ({
  queryKey: keys.availability.everyone(date),
  queryFn: async () => {
    const base = query(rangeFrom(date, 7));
    const items: FriendAvailability[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/api/v1/friend-availabilities?${base}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await apiGet(path, friendAvailabilityPageSchema);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  },
});

export const mineQuery = (date: string) => ({
  queryKey: keys.availability.mine(date),
  queryFn: () => apiGet(`/api/v1/availabilities?${query(rangeFrom(date, 14))}`, myAvailabilityListSchema),
});

export const rulesQuery = () => ({
  queryKey: keys.availability.rules(),
  queryFn: () => apiGet("/api/v1/recurrence-rules", recurrenceRuleListSchema),
});

export const presetsQuery = () => ({
  queryKey: keys.availability.presets(),
  queryFn: () => apiGet("/api/v1/me/presets", presetsSchema),
});

export const friendSlotsQuery = (friendId: string, date: string) => ({
  queryKey: keys.availability.friend(friendId, date),
  queryFn: () =>
    apiGet(`/api/v1/friends/${encodeURIComponent(friendId)}/availabilities?${query(rangeFrom(date, 14))}`, slotListSchema),
});
