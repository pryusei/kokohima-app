import { directInviteSchema, type DirectInvite } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { addDays, formatDate, formatTime, localDateOf, localInstant } from "../availability/format";
import { Link, Nav } from "../components/Nav";
import { formatRange, KIND_LABELS, linkLabel, statusClass, statusText } from "../invitations/format";
import { inviteQuery } from "../invitations/queries";
import { displayNameOf } from "./FriendsPage";

// 誘いの詳細と返答（仮。docs/specs/T-04-direct-invite.md「画面」）

type Action =
  | { path: "responses"; body: { response: "accept" } | { response: "decline" } | { response: "counter"; startsAt: string; endsAt: string } }
  | { path: "decide"; body: { decision: "accept" | "skip" } };

/** 押したらすぐに表示する状態（楽観的更新）。成立の予定のIDなどはサーバーの応答で埋める */
function optimisticStatus(action: Action): DirectInvite["status"] {
  if (action.path === "decide") return action.body.decision === "accept" ? "confirmed" : "skipped";
  if (action.body.response === "accept") return "confirmed";
  return action.body.response === "decline" ? "declined" : "counter_proposed";
}

function CounterForm({ invite, onSubmit }: { invite: DirectInvite; onSubmit: (startsAt: string, endsAt: string) => void }) {
  const [date, setDate] = useState(localDateOf(invite.startsAt));
  const [start, setStart] = useState(formatTime(invite.startsAt));
  const [end, setEnd] = useState(formatTime(invite.endsAt));
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const startsAt = localInstant(date, start);
        let endsAt = localInstant(date, end);
        if (endsAt <= startsAt) endsAt = localInstant(addDays(date, 1), end);
        onSubmit(new Date(startsAt).toISOString(), new Date(endsAt).toISOString());
      }}
    >
      <label className="flex flex-col gap-1">
        日付
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        開始
        <input type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1">
        終了
        <input type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <button type="submit" className="rounded border px-3 py-1">
        この時間で返す
      </button>
    </form>
  );
}

export function InviteDetailPage({ inviteId }: { inviteId: string }) {
  const queryClient = useQueryClient();
  const invite = useQuery(inviteQuery(inviteId));
  const [failed, setFailed] = useState<string | null>(null);
  const [countering, setCountering] = useState(false);
  const key = keys.invites.detail(inviteId);

  // 返答・決定は押したらすぐ表示を変え、失敗したら戻して静かな文言を出す。409 なら最新の状態を読み直す
  const act = useMutation({
    mutationFn: (action: Action) =>
      apiSend("POST", `/api/v1/direct-invites/${encodeURIComponent(inviteId)}/${action.path}`, action.body, directInviteSchema),
    onMutate: async (action) => {
      setFailed(null);
      setCountering(false);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<DirectInvite>(key);
      queryClient.setQueryData<DirectInvite>(key, (d) => d && { ...d, status: optimisticStatus(action) });
      return { previous };
    },
    onError: (error, _action, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      setFailed(
        error instanceof ApiError && error.status === 409
          ? "この誘いはもう返事ができません。最新の状態を表示しました"
          : "送れませんでした。もう一度お試しください",
      );
    },
    onSuccess: (updated) => {
      if (updated) queryClient.setQueryData(key, updated);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.invites.all() });
      await queryClient.invalidateQueries({ queryKey: keys.meetups.all() });
    },
  });

  if (invite.error instanceof ApiError && invite.error.status === 404) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <Nav />
        <p className="text-slate-600">この誘いは見つかりませんでした。</p>
      </main>
    );
  }
  const d = invite.data;
  const host = d ? linkLabel(d.url) : null;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">{d ? KIND_LABELS[d.kind] : "誘い"}</h1>
      <Nav />
      {d && (
        <section className="flex flex-col gap-2">
          <p>
            {d.direction === "received" ? "誘ってくれた人" : "誘った相手"}：
            <span className="font-bold">{displayNameOf(d.counterpart.displayName)}</span>
          </p>
          <p>{formatRange(d)}</p>
          {d.area && <p>エリア：{d.area}</p>}
          {d.message && <p className="whitespace-pre-wrap">{d.message}</p>}
          {d.url && host && (
            <a href={d.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
              {host}
            </a>
          )}
          <p className={statusClass(d.status)}>{statusText(d)}</p>
          {d.status === "pending" && (
            <p className="text-sm text-slate-600">
              返事の期限：{formatDate(localDateOf(d.expiresAt))} {formatTime(d.expiresAt)}
            </p>
          )}
          {d.meetupId && (
            <Link to={`/meetups/${d.meetupId}`} className="underline">
              成立した予定を見る
            </Link>
          )}

          {d.direction === "received" && d.status === "pending" && (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <button type="button" className="rounded-lg bg-amber-300 px-4 py-2" onClick={() => act.mutate({ path: "responses", body: { response: "accept" } })}>
                  行く
                </button>
                <button type="button" className="rounded-lg border px-4 py-2" onClick={() => act.mutate({ path: "responses", body: { response: "decline" } })}>
                  今回は難しい
                </button>
                <button type="button" className="rounded-lg border px-4 py-2" onClick={() => setCountering((v) => !v)}>
                  この時間なら
                </button>
              </div>
              {countering && (
                <CounterForm
                  invite={d}
                  onSubmit={(startsAt, endsAt) =>
                    act.mutate({ path: "responses", body: { response: "counter", startsAt, endsAt } })
                  }
                />
              )}
            </div>
          )}

          {d.direction === "sent" && d.status === "counter_proposed" && (
            <div className="flex gap-2">
              <button type="button" className="rounded-lg bg-amber-300 px-4 py-2" onClick={() => act.mutate({ path: "decide", body: { decision: "accept" } })}>
                決める
              </button>
              <button type="button" className="rounded-lg border px-4 py-2" onClick={() => act.mutate({ path: "decide", body: { decision: "skip" } })}>
                見送る
              </button>
            </div>
          )}
          {failed && (
            <p role="status" className="text-sm text-slate-600">
              {failed}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
