import { friendWishGroupPageSchema, wishListSchema, wishSchema } from "@kokohima/shared";
import { apiGet } from "../api/client";
import { keys } from "../api/keys";
import { isRateLimited } from "../availability/queries";

// 行きたいの取得（docs/specs/T-22-wishlist.md「API」。data-fetching スキル：キーは keys.ts の工場から）

export const myWishesQuery = () => ({
  queryKey: keys.wishes.mine(),
  queryFn: () => apiGet("/api/v1/wishes", wishListSchema),
});

/** 1件。作成画面に中身を入れるときに読む。読めなければ空で開くので、取り直さない */
export const wishQuery = (id: string) => ({
  queryKey: keys.wishes.detail(id),
  queryFn: () => apiGet(`/api/v1/wishes/${encodeURIComponent(id)}`, wishSchema),
  retry: false,
});

/** 「みんな」の友達の行きたい（友達ごと。もっと見るで続きを読む） */
export const friendWishesQuery = () => ({
  queryKey: keys.wishes.friends(),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam }: { pageParam: string | null }) =>
    apiGet(`/api/v1/friend-wishes${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`, friendWishGroupPageSchema),
  getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor,
  // 回数の上限（429）のあとは取り直さない
  retry: (count: number, error: unknown) => !isRateLimited(error) && count < 3,
});

export const friendWishListQuery = (friendId: string) => ({
  queryKey: keys.wishes.friend(friendId),
  queryFn: () => apiGet(`/api/v1/friends/${encodeURIComponent(friendId)}/wishes`, wishListSchema),
});
