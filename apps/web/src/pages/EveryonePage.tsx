import type { FriendAvailability } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { formatDate, formatSlot, localDateOf } from "../availability/format";
import { everyoneQuery, today } from "../availability/queries";
import { initialRange } from "../invitations/format";
import { AvailabilityChip } from "../ui/AvailabilityChip";
import { Avatar } from "../ui/Avatar";
import { ButtonLink } from "../ui/Button";
import { EmptyState, LoadError, Loading } from "../ui/feedback";
import { Link } from "../ui/Link";
import { TabScreen } from "../ui/Navigation";
import { displayNameOf } from "../account/me";

// ホーム＝「みんな」（docs/specs/T-03-availability.md「画面」、キャンバス「4 みんな」）

/** 枠の時間を入れた誘いの作成へ（開始は次の15分の区切り以降、長さは24時間まで）。終わりかけの枠は null */
function inviteLink(item: FriendAvailability) {
  const range = initialRange(item, Date.now());
  if (!range) return null;
  const params = new URLSearchParams({ friend: item.friend.id, startsAt: range.startsAt, endsAt: range.endsAt });
  return `/invites/new?${params.toString()}`;
}

function InviteFromSlot({ item }: { item: FriendAvailability }) {
  const to = inviteLink(item);
  if (!to) return null;
  return (
    <Link to={to} className="self-start text-s text-action underline">
      この時間に誘う
    </Link>
  );
}

function groupByDate(items: FriendAvailability[]) {
  const groups = new Map<string, FriendAvailability[]>();
  for (const item of items) {
    const date = localDateOf(item.startsAt);
    const list = groups.get(date) ?? [];
    list.push(item);
    groups.set(date, list);
  }
  return [...groups.entries()];
}

export function EveryonePage() {
  const date = today();
  const everyone = useQuery(everyoneQuery(date));

  return (
    <TabScreen title="みんな">
      <ButtonLink to="/broadcasts/new" variant="lamp" block>
        暇な人いる？と募る
      </ButtonLink>
      {everyone.isPending && <Loading />}
      {everyone.isError && <LoadError retry={() => void everyone.refetch()} />}
      {everyone.data?.length === 0 && (
        <EmptyState
          title="まだ友達のここ暇はありません"
          description="友達を招待すると、ここに暇な時間が並びます"
          action={
            <ButtonLink to="/friends" size="s">
              招待リンクを作る
            </ButtonLink>
          }
        />
      )}
      {everyone.data &&
        groupByDate(everyone.data).map(([day, items]) => (
          <section key={day} className="flex flex-col">
            <h2 className="-mx-4 bg-head px-4 py-1 font-bold tabular-nums">{formatDate(day)}</h2>
            <ul className="flex flex-col">
              {items.map((item) => (
                <li key={`${item.friend.id}|${item.startsAt}`} className="flex gap-2 border-b border-line py-3 last:border-b-0">
                  <Avatar name={item.friend.displayName} />
                  <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <Link to={`/friends/${item.friend.id}`} className="font-bold text-ink no-underline">
                      {displayNameOf(item.friend.displayName)}
                    </Link>
                    <AvailabilityChip text={formatSlot(item)} overlaps={item.overlapsMine} />
                    <InviteFromSlot item={item} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </TabScreen>
  );
}
