import { broadcastSchema, type Broadcast } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { Link, Nav } from "../components/Nav";
import { broadcastStatusClass, broadcastStatusText, formatRange, linkLabel } from "../invitations/format";
import { broadcastQuery } from "../invitations/queries";
import { displayNameOf } from "./FriendsPage";

// 募集の詳細（仮。docs/specs/T-05-broadcast.md「画面」）。宛先の人には人数・名前・ほかの宛先を出さない

type Action = "respond" | "withdraw" | "decide";

const request = (id: string, action: Action) => {
  const base = `/api/v1/broadcasts/${encodeURIComponent(id)}`;
  if (action === "respond") return apiSend("POST", `${base}/responses`, undefined, broadcastSchema);
  if (action === "withdraw") return apiSend("DELETE", `${base}/responses/me`, undefined, broadcastSchema);
  return apiSend("POST", `${base}/decide`, undefined, broadcastSchema);
};

function Actions({ b }: { b: Broadcast }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  const key = keys.broadcasts.detail(b.id);
  const act = useMutation({
    mutationFn: (action: Action) => request(b.id, action),
    onMutate: () => setFailed(null),
    onSuccess: (updated) => {
      if (updated) queryClient.setQueryData(key, updated);
    },
    onError: (error) => {
      // 409 なら最新の状態を読み直して表示する
      setFailed(
        error instanceof ApiError && error.status === 409
          ? "状態が変わっていました。最新の状態を表示しました"
          : "送れませんでした。もう一度お試しください",
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.broadcasts.all() });
      await queryClient.invalidateQueries({ queryKey: keys.meetups.all() });
    },
  });

  const button = (action: Action, label: string, primary = false) => (
    <button
      type="button"
      disabled={act.isPending}
      className={primary ? "rounded-lg bg-amber-300 px-4 py-2 disabled:opacity-50" : "rounded-lg border px-4 py-2 disabled:opacity-50"}
      onClick={() => act.mutate(action)}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      {b.direction === "sent" && b.status === "open" && (b.responseCount ?? 0) >= 1 && button("decide", "決める", true)}
      {b.direction === "sent" && b.status === "expired" && (
        <Link to={`/broadcasts/new?from=${b.id}`} className="self-start rounded-lg border px-4 py-2">
          もう一度募集する
        </Link>
      )}
      {b.direction === "received" && b.status === "open" &&
        (b.respondedByMe ? button("withdraw", "応じるのをやめる") : button("respond", "応じる", true))}
      {b.meetupId && (
        <Link to={`/meetups/${b.meetupId}`} className="underline">
          成立した予定を見る
        </Link>
      )}
      {failed && (
        <p role="status" className="text-sm text-slate-600">
          {failed}
        </p>
      )}
    </div>
  );
}

export function BroadcastDetailPage({ broadcastId }: { broadcastId: string }) {
  const broadcast = useQuery(broadcastQuery(broadcastId));

  if (broadcast.error instanceof ApiError && broadcast.error.status === 404) {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <Nav />
        <p className="text-slate-600">この募集は見つかりませんでした。</p>
      </main>
    );
  }
  const b = broadcast.data;
  const host = b ? linkLabel(b.url) : null;

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
      <h1 className="text-2xl font-bold">暇な人いる？</h1>
      <Nav />
      {b && (
        <section className="flex flex-col gap-2">
          <p>
            {b.direction === "received" ? (
              <>
                募集した人：<span className="font-bold">{displayNameOf(b.owner.displayName)}</span>
              </>
            ) : (
              <>宛先：{b.recipients?.length ?? 0}人</>
            )}
          </p>
          <p>{formatRange(b)}</p>
          {b.area && <p>エリア：{b.area}</p>}
          {b.message && <p className="whitespace-pre-wrap">{b.message}</p>}
          {b.url && host && (
            <a href={b.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
              {host}
            </a>
          )}
          <p className={broadcastStatusClass(b.status)}>{broadcastStatusText(b)}</p>
          <Actions b={b} />
        </section>
      )}
    </main>
  );
}
