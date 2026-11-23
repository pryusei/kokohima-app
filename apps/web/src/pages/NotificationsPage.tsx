import type { NotificationDto } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { keys } from "../api/keys";
import { notificationsQuery } from "../notifications/queries";
import { linkOf, textOf } from "../notifications/text";
import { SendButton } from "../ui/Button";
import { EmptyState, LoadError, Loading, Toast } from "../ui/feedback";
import { SubScreen } from "../ui/Navigation";
import { NotificationRow } from "../ui/NotificationRow";

// お知らせ一覧（docs/specs/T-07-notification.md「お知らせ一覧」、キャンバス「18 お知らせ」）。断り・キャンセルも同じ静かな見た目で出す
// ヘッダーの鐘から開く。左上の「戻る」で、開いた画面（なければ「みんな」）へ戻る

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
    return <Toast>見せないにしました</Toast>;
  }
  return (
    <div className="flex flex-col gap-1">
      <SendButton size="s" className="self-start" disabled={hide.isPending} onClick={() => hide.mutate()}>
        この人に見せない
      </SendButton>
      {state === "failed" && (
        <p role="status" className="text-s text-ink-muted">
          変更できませんでした。もう一度お試しください
        </p>
      )}
    </div>
  );
}

function Item({ n }: { n: NotificationDto }) {
  return (
    <NotificationRow to={linkOf(n)} text={textOf(n)} unread={n.readAt === null} avatarName={n.actor?.displayName ?? null} avatarUrl={n.actor?.avatarUrl ?? null}>
      {n.kind === "friend_added" && n.subjectId && <HideFromFriend friendId={n.subjectId} />}
    </NotificationRow>
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
    <SubScreen title="お知らせ" back="/">
      {notifications.isPending && <Loading />}
      {notifications.isError && (
        <LoadError text="読み込めませんでした。通信状態を確認して、もう一度お試しください" retry={() => void notifications.refetch()} />
      )}
      {notifications.data && notifications.data.items.length === 0 && <EmptyState title="お知らせはありません" />}
      {notifications.data && notifications.data.items.length > 0 && (
        <ul className="-mx-4 flex flex-col border-t border-line">
          {notifications.data.items.map((n) => (
            <Item key={n.id} n={n} />
          ))}
        </ul>
      )}
    </SubScreen>
  );
}
