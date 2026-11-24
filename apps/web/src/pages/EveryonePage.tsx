import type { Friend, FriendAvailability } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { formatDate, formatSlot, isNow, localDateOf } from "../availability/format";
import { FreeNowCard } from "../availability/FreeNowCard";
import { everyoneQuery, isRateLimited, today } from "../availability/queries";
import { useNow } from "../availability/useNow";
import { initialRange } from "../invitations/format";
import { AvailabilityChip } from "../ui/AvailabilityChip";
import { Avatar } from "../ui/Avatar";
import { Button, ButtonLink } from "../ui/Button";
import { EmptyState, LoadError, Loading } from "../ui/feedback";
import { Link } from "../ui/Link";
import { TabScreen } from "../ui/Navigation";
import { everyFriendQuery } from "../account/friends";
import { InviteLinkSheet } from "../account/InviteLinkSheet";
import { displayNameOf } from "../account/me";
import { FriendWishes } from "../wish/FriendWishes";

// ホーム＝「みんな」（docs/specs/T-03-availability.md「画面」、キャンバス「4 みんな」）
// 「誰を誘う？」と、友達の有無で分けた空の状態は docs/specs/T-34-kokodou-entry.md
// 一番上の今ひまのボタンと、友達の行の「今」の印は docs/specs/T-40-ima-hima.md

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

/**
 * 「誰を誘う？」：友達全員の顔を横に並べ、押すとその友達を入れた誘いの作成を開く（T-34）。
 * 友達の一覧（T-02）の並びのまま、ここ暇の有無や見せる／見せないで並べ替えも印付けもしない
 */
function WhoToInvite({ friends }: { friends: Friend[] }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-l font-bold">
        誰を誘う？
      </h2>
      <ul className="-mx-4 flex gap-3 overflow-x-auto px-4 pt-1 pb-1 lg:-mx-6 lg:px-6">
        {friends.map((f) => {
          const name = displayNameOf(f.displayName);
          return (
            <li key={f.id} className="shrink-0">
              <Link
                to={`/invites/new?friend=${encodeURIComponent(f.id)}`}
                aria-label={`${name}を誘う`}
                className="flex w-16 flex-col items-center gap-1 text-ink no-underline transition-transform duration-(--duration-press) ease-out active:scale-[.95]"
              >
                <Avatar name={f.displayName} src={f.avatarUrl} size="l" />
                <span className="w-full truncate text-center text-s">{name}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 「今」の印（今ひま。T-40）。見えている枠のうち、今を15分で切り上げた時刻までに始まり、まだ終わっていない枠にだけ付ける。
 * 時刻はこの部品の中で30秒ごとに取り直す（「みんな」全体を描き直さない） */
function NowMark({ slot }: { slot: FriendAvailability }) {
  const now = useNow();
  if (!isNow(slot, now)) return null;
  return (
    <span className="rounded-full bg-lamp px-1.5 text-xs font-bold text-on-lamp">
      今<span className="sr-only">ひま</span>
    </span>
  );
}

export function EveryonePage() {
  const date = today();
  // 友達とここ暇は並列に読む（取得の連鎖を作らない。data-fetching スキル）
  const friends = useQuery(everyFriendQuery());
  const everyone = useQuery(everyoneQuery(date));
  const [inviting, setInviting] = useState(false);

  // 友達が0人：招待の1つのボタンだけを出す（顔の列・募るボタン・ここ暇の一覧は出さない）
  if (friends.data?.length === 0) {
    return (
      <TabScreen title="みんな">
        <EmptyState
          title="まだ友達はいません"
          description="友達を招待すると、ここに暇な時間が並びます"
          action={
            <Button variant="primary" onClick={() => setInviting(true)}>
              友達を招待する
            </Button>
          }
        />
        {inviting && <InviteLinkSheet onClose={() => setInviting(false)} />}
      </TabScreen>
    );
  }

  return (
    <TabScreen title="みんな">
      <FreeNowCard />
      {friends.data && <WhoToInvite friends={friends.data} />}
      {friends.isError && <LoadError text="友達を読み込めませんでした" retry={() => void friends.refetch()} />}
      <ButtonLink to="/broadcasts/new" variant="lamp" block>
        暇な人いる？と募る
      </ButtonLink>
      {everyone.isPending && <Loading variant="chips" />}
      {everyone.isError && !isRateLimited(everyone.error) && <LoadError retry={() => void everyone.refetch()} />}
      {/* 回数の上限（429。T-14）：前に読めた内容があれば出したまま。なければ静かに待ってもらう（取り直さない） */}
      {everyone.isError && isRateLimited(everyone.error) && !everyone.data && (
        <LoadError text="少し時間をおいて、もう一度開いてください" />
      )}
      {/* 友達はいるが、見えているここ暇がない：上の顔の列と募るボタンで誘える（T-34）。
          顔の列が出ていない（友達の一覧を読み込み中・読めない）ときは、顔を指す説明を出さない */}
      {everyone.data?.length === 0 && (
        <EmptyState
          title="まだ友達のここ暇はありません"
          description={friends.data ? "ここ暇がなくても、上の顔から「ここどう？」と誘えます" : undefined}
        />
      )}
      {everyone.data && everyone.data.length > 0 && (
        <section aria-label="みんなのここ暇" className="flex flex-col gap-4">
          {groupByDate(everyone.data).map(([day, items]) => (
            <section key={day} className="flex flex-col">
              {/* 日付の帯は上に貼り付き、次の日の帯が来たら押し上げられる（docs/specs/T-56-motion.md「M-17」。重なりはシート・下のタブより下） */}
              <h2 className="sticky top-0 z-[1] -mx-4 bg-head px-4 py-1 font-bold tabular-nums lg:-mx-6 lg:px-6">{formatDate(day)}</h2>
              <ul className="flex flex-col">
                {items.map((item) => (
                  <li key={`${item.friend.id}|${item.startsAt}`} className="flex gap-2 border-b border-line py-3 last:border-b-0">
                    <Avatar name={item.friend.displayName} src={item.friend.avatarUrl} />
                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <span className="flex items-center gap-2">
                        <Link to={`/friends/${item.friend.id}`} className="font-bold text-ink no-underline">
                          {displayNameOf(item.friend.displayName)}
                        </Link>
                        <NowMark slot={item} />
                      </span>
                      <AvailabilityChip text={formatSlot(item)} overlaps={item.overlapsMine} lampKey={`${item.friend.id}|${item.startsAt}|${item.endsAt}`} />
                      <InviteFromSlot item={item} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </section>
      )}
      <FriendWishes />
    </TabScreen>
  );
}
