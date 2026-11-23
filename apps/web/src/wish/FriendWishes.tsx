import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { displayNameOf } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Button, ButtonLink } from "../ui/Button";
import { Link } from "../ui/Link";
import { Section } from "../ui/Navigation";
import { friendWishesQuery, friendWishListQuery } from "./queries";
import { WishCard } from "./WishCard";

// 友達の行きたい（docs/specs/T-22-wishlist.md「画面」）。1件もないとき・読めないときは欄を出さない
// （外されている友達と、何も置いていない友達を区別させないため、空の案内も出さない）

const inviteFrom = (wishId: string) => `/invites/new?wish=${encodeURIComponent(wishId)}`;

function InviteHere({ wishId }: { wishId: string }) {
  return (
    <ButtonLink to={inviteFrom(wishId)} size="s" variant="primary">
      ここで誘う
    </ButtonLink>
  );
}

/** 「みんな」の下。友達ごとにまとめる */
export function FriendWishes() {
  const wishes = useInfiniteQuery(friendWishesQuery());
  const groups = wishes.data?.pages.flatMap((p) => p.items) ?? [];
  if (groups.length === 0) return null;
  return (
    <Section title="友達の行きたい">
      <ul aria-label="友達の行きたい" className="flex flex-col">
        {groups.map((group) => (
          <li key={group.friend.id} className="flex gap-2 border-b border-line py-3 last:border-b-0">
            <Avatar name={group.friend.displayName} src={group.friend.avatarUrl} />
            <div className="flex min-w-0 flex-1 flex-col">
              <Link to={`/friends/${group.friend.id}`} className="font-bold text-ink no-underline">
                {displayNameOf(group.friend.displayName)}
              </Link>
              {group.wishes.map((wish) => (
                <WishCard key={wish.id} wish={wish} actions={<InviteHere wishId={wish.id} />} />
              ))}
            </div>
          </li>
        ))}
      </ul>
      {wishes.hasNextPage && (
        <Button size="s" variant="ghost" disabled={wishes.isFetchingNextPage} onClick={() => void wishes.fetchNextPage()}>
          もっと見る
        </Button>
      )}
    </Section>
  );
}

/** 友達の詳細の中 */
export function FriendWishList({ friendId }: { friendId: string }) {
  const wishes = useQuery(friendWishListQuery(friendId));
  const items = wishes.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Section title="行きたい">
      <ul aria-label="友達の行きたい" className="flex flex-col">
        {items.map((wish) => (
          <li key={wish.id}>
            <WishCard wish={wish} actions={<InviteHere wishId={wish.id} />} />
          </li>
        ))}
      </ul>
    </Section>
  );
}
