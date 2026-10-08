import { friendSchema, type Friend } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { formatDate, formatSlot, localDateOf } from "../availability/format";
import { friendSlotsQuery, today } from "../availability/queries";
import { Link, Nav } from "../components/Nav";
import { navigate } from "../router";
import { displayNameOf } from "./FriendsPage";

// 友達の詳細（仮。docs/specs/T-03-availability.md「画面」）

function Settings({ friend }: { friend: Friend }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  const name = displayNameOf(friend.displayName);

  // 「自分の暇を見せる」は楽観的更新（data-fetching スキル）
  const toggle = useMutation({
    mutationFn: (sharesMyAvailability: boolean) =>
      apiSend("PATCH", `/api/v1/friends/${friend.id}`, { sharesMyAvailability }),
    onMutate: async (sharesMyAvailability) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.friends.detail(friend.id) });
      const previous = queryClient.getQueryData<Friend>(keys.friends.detail(friend.id));
      queryClient.setQueryData<Friend>(keys.friends.detail(friend.id), (f) => f && { ...f, sharesMyAvailability });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(keys.friends.detail(friend.id), context.previous);
      setFailed(true);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.friends.all() }),
  });

  const unfriend = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/friends/${friend.id}`, undefined),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.friends.all() });
      await queryClient.invalidateQueries({ queryKey: keys.availability.all() });
      navigate("/friends");
    },
    onError: () => setFailed(true),
  });

  return (
    <section className="flex flex-col gap-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          role="switch"
          checked={friend.sharesMyAvailability}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        自分の暇を見せる
      </label>
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p className="text-slate-600">解除しても相手には通知されません。</p>
          <div className="flex gap-2">
            <button type="button" className="rounded border px-3 py-1" onClick={() => unfriend.mutate()}>
              {name}さんとの友達を解除する
            </button>
            <button type="button" className="rounded border px-3 py-1" onClick={() => setConfirming(false)}>
              やめる
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="self-start text-sm text-slate-600 underline" onClick={() => setConfirming(true)}>
          友達を解除
        </button>
      )}
      {failed && (
        <p role="status" className="text-sm text-slate-600">
          保存できませんでした。もう一度お試しください。
        </p>
      )}
    </section>
  );
}

export function FriendDetailPage({ friendId }: { friendId: string }) {
  const date = today();
  const friend = useQuery({
    queryKey: keys.friends.detail(friendId),
    queryFn: () => apiGet(`/api/v1/friends/${encodeURIComponent(friendId)}`, friendSchema),
  });
  const slots = useQuery({ ...friendSlotsQuery(friendId, date), enabled: friend.isSuccess });

  if (friend.error instanceof ApiError && friend.error.status === 404) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <Nav />
        <p className="text-slate-600">この友達は見つかりませんでした。</p>
        <Link to="/friends" className="underline">
          友達一覧へ
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">{friend.data ? displayNameOf(friend.data.displayName) : "友達"}</h1>
      <Nav />
      {friend.isError && (
        <p role="status" className="text-slate-600">
          読み込めませんでした。通信状態を確認して、もう一度お試しください。
        </p>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">ここ暇</h2>
        {slots.data?.items.length === 0 && <p className="text-slate-600">見えているここ暇はありません</p>}
        <ul aria-label="友達のここ暇" className="flex flex-col gap-2">
          {slots.data?.items.map((s) => (
            <li key={s.startsAt} className="rounded-lg border border-slate-200 bg-white p-3">
              {formatDate(localDateOf(s.startsAt))} {formatSlot(s)}
            </li>
          ))}
        </ul>
      </section>
      {friend.data && <Settings friend={friend.data} />}
    </main>
  );
}
