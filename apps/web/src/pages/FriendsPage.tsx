import {
  createdInviteLinkSchema,
  friendPageSchema,
  inviteLinkPageSchema,
  INVITE_DEFAULTS,
  meResponseSchema,
  type CreatedInviteLink,
  type Friend,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { useAuth } from "../auth/AuthProvider";
import { Link, Nav } from "../components/Nav";

// 友達タブ（仮。最終的なデザインはデザインのタスクで差し替える）
// docs/specs/T-02-friends.md「画面」

type FriendPage = { items: Friend[]; nextCursor: string | null };

export const displayNameOf = (name: string | null) => name ?? "名前未設定の友達";

function FriendRow({ friend }: { friend: Friend }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);

  // 「自分の暇を見せる」は楽観的更新（data-fetching スキル）
  const toggle = useMutation({
    mutationFn: (sharesMyAvailability: boolean) =>
      apiSend("PATCH", `/api/v1/friends/${friend.id}`, { sharesMyAvailability }),
    onMutate: async (sharesMyAvailability) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.friends.list() });
      const previous = queryClient.getQueryData<FriendPage>(keys.friends.list());
      queryClient.setQueryData<FriendPage>(keys.friends.list(), (page) =>
        page && {
          ...page,
          items: page.items.map((f) => (f.id === friend.id ? { ...f, sharesMyAvailability } : f)),
        },
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(keys.friends.list(), context.previous);
      setFailed(true);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.friends.list() }),
  });

  const unfriend = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/friends/${friend.id}`, undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.friends.all() }),
    onError: () => setFailed(true),
  });

  const name = displayNameOf(friend.displayName);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
      <Link to={`/friends/${friend.id}`} className="font-bold underline">
        {name}
      </Link>
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
    </li>
  );
}

function DisplayNameForm() {
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: () => apiSend("PATCH", "/api/v1/me", { displayName: value }, meResponseSchema),
    onSuccess: (me) => queryClient.setQueryData(keys.me(), me),
  });
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <p className="text-slate-600">招待リンクを作る前に、友達に表示する名前を決めてください。</p>
      <label className="flex flex-col gap-1">
        表示名
        <input
          className="rounded border px-2 py-1"
          value={value}
          maxLength={20}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button type="submit" disabled={save.isPending || value.trim() === ""} className="rounded border px-3 py-2">
        保存する
      </button>
      {save.isError && <p className="text-sm text-slate-600">保存できませんでした。1〜20文字で入力してください。</p>}
    </form>
  );
}

function InviteLinks() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: keys.me(), queryFn: () => apiGet("/api/v1/me", meResponseSchema) });
  const links = useQuery({
    queryKey: keys.inviteLinks.list(),
    queryFn: () => apiGet("/api/v1/invite-links", inviteLinkPageSchema),
  });
  const [expiresInDays, setExpiresInDays] = useState<1 | 3 | 7>(INVITE_DEFAULTS.expiresInDays);
  const [maxUses, setMaxUses] = useState<number>(INVITE_DEFAULTS.maxUses);
  const [created, setCreated] = useState<CreatedInviteLink | null>(null);

  const create = useMutation({
    mutationFn: () => apiSend("POST", "/api/v1/invite-links", { expiresInDays, maxUses }, createdInviteLinkSchema),
    onSuccess: (link) => {
      setCreated(link ?? null);
      void queryClient.invalidateQueries({ queryKey: keys.inviteLinks.list() });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => apiSend("POST", `/api/v1/invite-links/${id}/revoke`, undefined),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.inviteLinks.list() }),
  });

  if (me.data && me.data.displayName === null) return <DisplayNameForm />;

  const share = async (url: string) => {
    if (navigator.share) await navigator.share({ url }).catch(() => undefined);
    else await navigator.clipboard?.writeText(url).catch(() => undefined);
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">招待リンク</h2>
      <div className="flex gap-2">
        <label className="flex flex-col">
          期限
          <select value={expiresInDays} onChange={(e) => setExpiresInDays(Number(e.target.value) as 1 | 3 | 7)}>
            <option value={1}>1日</option>
            <option value={3}>3日</option>
            <option value={7}>7日</option>
          </select>
        </label>
        <label className="flex flex-col">
          人数
          <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}人
              </option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        disabled={create.isPending}
        className="rounded-lg bg-amber-300 px-4 py-3 disabled:opacity-50"
        onClick={() => create.mutate()}
      >
        招待リンクを作る
      </button>
      {create.isError && (
        <p role="status" className="text-sm text-slate-600">
          作れませんでした。時間をおいてもう一度お試しください。
        </p>
      )}
      {created && (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-sm text-slate-600">このURLはこの画面でしか表示できません。今のうちに友達に送ってください。</p>
          <input aria-label="招待リンクのURL" readOnly className="rounded border px-2 py-1" value={created.url} />
          <button type="button" className="rounded border px-3 py-2" onClick={() => void share(created.url)}>
            共有する
          </button>
        </div>
      )}
      {links.data && links.data.items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {links.data.items.map((l) => (
            <li key={l.id} className="flex items-center justify-between text-sm">
              <span>
                {new Date(l.expiresAt).toLocaleDateString()}まで・{l.uses}/{l.maxUses}人
              </span>
              <button type="button" className="underline" onClick={() => revoke.mutate(l.id)}>
                無効にする
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** ログアウト（T-03でホームから移した。docs/specs/T-03-availability.md「画面」） */
function Account() {
  const { logout, logoutAll } = useAuth();
  const [failed, setFailed] = useState(false);
  const me = useQuery({ queryKey: keys.me(), queryFn: () => apiGet("/api/v1/me", meResponseSchema) });
  const run = (action: () => Promise<boolean>) => async () => {
    setFailed(false);
    if (!(await action())) setFailed(true);
  };
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">アカウント</h2>
      {me.data && <p className="text-slate-600">{me.data.displayName ?? "表示名は未設定です"}</p>}
      {failed && (
        <p role="status" className="text-slate-600">
          ログアウトできませんでした。通信状態を確認して、もう一度お試しください。
        </p>
      )}
      <button type="button" className="rounded-lg border border-slate-300 px-4 py-3" onClick={run(logout)}>
        ログアウト
      </button>
      <button type="button" className="rounded-lg border border-slate-300 px-4 py-3" onClick={run(logoutAll)}>
        すべての端末からログアウト
      </button>
    </section>
  );
}

export function FriendsPage() {
  const friends = useQuery({ queryKey: keys.friends.list(), queryFn: () => apiGet("/api/v1/friends", friendPageSchema) });

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">友達</h1>
      <Nav />
      <InviteLinks />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">友達一覧</h2>
        {friends.data?.items.length === 0 && <p className="text-slate-600">まだ友達がいません。</p>}
        <ul aria-label="友達一覧" className="flex flex-col gap-2">
          {friends.data?.items.map((f) => <FriendRow key={f.id} friend={f} />)}
        </ul>
      </section>
      <Account />
    </main>
  );
}
