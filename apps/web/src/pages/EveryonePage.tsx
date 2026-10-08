import type { FriendAvailability } from "@kokohima/shared";
import { useQuery } from "@tanstack/react-query";
import { formatDate, formatSlot, localDateOf } from "../availability/format";
import { everyoneQuery, today } from "../availability/queries";
import { Link, Nav } from "../components/Nav";
import { initialRange } from "../invitations/format";
import { displayNameOf } from "./FriendsPage";

// ホーム＝「みんな」（仮。docs/specs/T-03-availability.md「画面」）

/** 枠の時間を入れた誘いの作成へ（開始は次の15分の区切り以降、長さは24時間まで） */
function inviteLink(item: FriendAvailability) {
  const range = initialRange(item, Date.now());
  const params = new URLSearchParams({ friend: item.friend.id, startsAt: range.startsAt, endsAt: range.endsAt });
  return `/invites/new?${params.toString()}`;
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
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">みんな</h1>
      <Nav />
      {everyone.isError && (
        <p role="status" className="text-slate-600">
          読み込めませんでした。通信状態を確認して、もう一度お試しください。
        </p>
      )}
      {everyone.data?.length === 0 && <p className="text-slate-600">まだ友達のここ暇はありません</p>}
      {everyone.data &&
        groupByDate(everyone.data).map(([day, items]) => (
          <section key={day} className="flex flex-col gap-2">
            <h2 className="font-bold">{formatDate(day)}</h2>
            <ul className="flex flex-col gap-2">
              {items.map((item) => (
                <li
                  key={`${item.friend.id}|${item.startsAt}`}
                  className={
                    item.overlapsMine
                      ? "flex flex-col rounded-lg border-2 border-amber-400 bg-amber-50 p-3"
                      : "flex flex-col rounded-lg border border-slate-200 bg-white p-3"
                  }
                >
                  <Link to={`/friends/${item.friend.id}`} className="font-bold underline">
                    {displayNameOf(item.friend.displayName)}
                  </Link>
                  <span>{formatSlot(item)}</span>
                  {item.overlapsMine && <span className="text-sm text-amber-800">自分のここ暇と重なっています</span>}
                  <Link to={inviteLink(item)} className="self-start text-sm underline">
                    この時間に誘う
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </main>
  );
}
