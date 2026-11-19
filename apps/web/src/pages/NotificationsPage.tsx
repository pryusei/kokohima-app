import type { NotificationDto } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { Link, Nav } from "../components/Nav";
import { notificationsQuery } from "../notifications/queries";
import { linkOf, textOf } from "../notifications/text";

// お知らせ一覧（仮。docs/specs/T-07-notification.md「お知らせ一覧」）。断り・キャンセルも同じ静かな見た目で出す

/** 友達追加のお知らせの「この人に見せない」（F-08） */
function HideFromFriend({ friendId }: { friendId: string }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<"idle" | "done" | "gone" | "failed">("idle");
  const hide = useMutation({
    mutationFn: () => apiSend("PATCH", `/api/v1/friends/${encodeURIComponent(friendId)}`, { sharesMyAvailability: false }),
    onSuccess: () => setState("done"),
    // 友達でなくなっていれば（404）、ボタンを消す
    onError: (err) => setState(err instanceof ApiError && err.status === 404 ? "gone" : "failed"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.friends.all() }),
  });
  if (state === "gone") return null;
  if (state === "done") {
    return (
      <p role="status" className="text-sm text-slate-600">
        見せないにしました
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        className="self-start rounded-lg border border-slate-300 px-3 py-1 text-sm"
        disabled={hide.isPending}
        onClick={() => hide.mutate()}
      >
        この人に見せない
      </button>
      {state === "failed" && (
        <p role="status" className="text-sm text-slate-600">
          変更できませんでした。もう一度お試しください
        </p>
      )}
    </div>
  );
}

function Item({ n }: { n: NotificationDto }) {
  return (
    <li className="flex flex-col gap-1 border-b border-slate-200 pb-3">
      <Link to={linkOf(n)} className={n.readAt === null ? "font-bold text-slate-900" : "text-slate-600"}>
        {textOf(n)}
      </Link>
      {n.kind === "friend_added" && n.subjectId && <HideFromFriend friendId={n.subjectId} />}
    </li>
  );
}

export function NotificationsPage() {
  const queryClient = useQueryClient();
  const notifications = useQuery(notificationsQuery());
  const newest = notifications.data?.items[0]?.id;
  const marked = useRef<string | null>(null);

  const { mutate: markRead } = useMutation({
    mutationFn: (upTo: string) => apiSend("POST", "/api/v1/notifications/read", { upTo }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.notifications.unread() }),
  });

  // 一覧を開いたら、見えているいちばん新しいお知らせまでを既読にする
  useEffect(() => {
    if (!newest || marked.current === newest) return;
    marked.current = newest;
    markRead(newest);
  }, [newest, markRead]);

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">お知らせ</h1>
      <Nav />
      {notifications.isPending && <p role="status">読み込み中…</p>}
      {notifications.isError && (
        <p role="status" className="text-slate-600">
          読み込めませんでした。通信状態を確認して、もう一度お試しください
        </p>
      )}
      {notifications.data && notifications.data.items.length === 0 && <p className="text-slate-600">お知らせはありません</p>}
      {notifications.data && notifications.data.items.length > 0 && (
        <ul className="flex flex-col gap-3">
          {notifications.data.items.map((n) => (
            <Item key={n.id} n={n} />
          ))}
        </ul>
      )}
    </main>
  );
}
