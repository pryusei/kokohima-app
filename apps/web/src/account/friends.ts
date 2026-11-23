import { friendPageSchema, type Friend } from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";

// 友達全員（募集の宛先、行きたいの見せない相手を選ぶため、続きのページも読む）

export const everyFriendQuery = () => ({
  queryKey: keys.friends.everyone(),
  queryFn: async () => {
    const items: Friend[] = [];
    let cursor: string | null = null;
    do {
      const path: string = `/api/v1/friends?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await apiGet(path, friendPageSchema);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  },
});
