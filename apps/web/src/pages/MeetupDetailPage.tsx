import { meetupSchema, type Meetup } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { createIcsLink } from "../calendar/queries";
import { redirectTo } from "./CalendarSettingsPage";
import { formatRange } from "../invitations/format";
import { meetupQuery } from "../invitations/queries";
import { displayNameOf } from "./FriendsPage";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { SheetScreen } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { LinkCard } from "../ui/LinkCard";

// 成立した予定（docs/specs/T-04-direct-invite.md「画面」、キャンバス「15 成立した予定」）。「やっぱり難しい」は確認なしで送る
// 後ろに誘いタブを出したシートで開く（docs/specs/T-11-design.md「画面のつながり」）

export function MeetupDetailPage({ meetupId }: { meetupId: string }) {
  const queryClient = useQueryClient();
  const meetup = useQuery(meetupQuery(meetupId));
  const [failed, setFailed] = useState(false);
  const [icsFailed, setIcsFailed] = useState<false | "failed" | "limited">(false);
  // 表示した時点の時刻で判定する（描画のたびに時計を読まない）
  const [openedAt] = useState(() => Date.now());
  const key = keys.meetups.detail(meetupId);

  const idempotency = useIdempotencyKey();
  const cancel = useMutation({
    mutationFn: () => {
      const path = `/api/v1/meetups/${encodeURIComponent(meetupId)}/cancel`;
      return apiSend("POST", path, undefined, meetupSchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, undefined)) });
    },
    onMutate: async () => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<Meetup>(key);
      queryClient.setQueryData<Meetup>(key, (m) => m && { ...m, status: "cancelled" });
      return { previous };
    },
    onError: (_e, _v, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
      setFailed(true);
    },
    onSettled: async (_data, error) => {
      idempotency.settle(error);
      await queryClient.invalidateQueries({ queryKey: keys.meetups.all() });
      await queryClient.invalidateQueries({ queryKey: keys.invites.all() });
    },
  });

  // .ics は一時的な URL を発行してから画面遷移する（iOS では OS のカレンダーへの追加が開く。決定事項10）
  const ics = useMutation({
    mutationFn: () => createIcsLink(meetupId),
    onMutate: () => setIcsFailed(false),
    onSuccess: (link) => {
      if (link) redirectTo.go(link.url);
    },
    // 回数の上限（429。T-10）は、少し待ってもらう
    onError: (error) => setIcsFailed(error instanceof ApiError && error.status === 429 ? "limited" : "failed"),
  });

  if (meetup.error instanceof ApiError && meetup.error.status === 404) {
    return (
      <SheetScreen title="成立した予定" label="成立した予定" parent="/invites">
        <p role="status">この予定は見つかりませんでした。</p>
      </SheetScreen>
    );
  }
  const m = meetup.data;
  // 開始後はキャンセルできないので、ボタンを出さない（決定事項4）
  const cancellable = m?.status === "confirmed" && Date.parse(m.startsAt) > openedAt;
  const cancelled = m?.status === "cancelled";

  return (
    <SheetScreen
      label="成立した予定"
      parent="/invites"
      title={
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-bold">成立した予定</h2>
          {m && (cancelled ? <Badge tone="quiet">やっぱり難しくなりました</Badge> : <Badge tone="meet">成立</Badge>)}
        </div>
      }
    >
      {meetup.isPending && <Loading />}
      {meetup.isError && !(meetup.error instanceof ApiError && meetup.error.status === 404) && (
        <LoadError retry={() => void meetup.refetch()} />
      )}
      {m && (
        <>
          <div className={`-mx-6 flex flex-col gap-1 px-6 py-4 ${cancelled ? "bg-quiet-bg" : "bg-meet-soft"}`}>
            <p className={`text-xl font-bold tabular-nums ${cancelled ? "text-quiet-ink" : "text-ink"}`}>{formatRange(m)}</p>
            {m.area && <p className={cancelled ? "text-quiet-ink" : "font-bold text-meet-ink"}>エリア：{m.area}</p>}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-bold text-ink-muted">参加する人</span>
            <ul className="flex flex-wrap gap-4">
              {m.participants.map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <Avatar name={p.displayName} size="s" />
                  {displayNameOf(p.displayName)}
                </li>
              ))}
            </ul>
          </div>
          {m.message && <p className="whitespace-pre-wrap">{m.message}</p>}
          <LinkCard url={m.url} preview={m.linkPreview} />
          <Button block onClick={() => ics.mutate()}>
            カレンダーに追加（.ics）
          </Button>
          {icsFailed && (
            <p role="status" className="text-s text-ink-muted">
              {icsFailed === "limited"
                ? "少し待ってから、もう一度お試しください"
                : "カレンダーに追加できませんでした。もう一度お試しください"}
            </p>
          )}
          {cancellable && (
            <>
              <SendButton variant="ghost" block onClick={() => cancel.mutate()}>
                やっぱり難しい
              </SendButton>
              <Note>押すと、ほかの参加者にお知らせが届きます</Note>
            </>
          )}
          {failed && (
            <p role="status" className="text-s text-ink-muted">
              送れませんでした。もう一度お試しください
            </p>
          )}
        </>
      )}
    </SheetScreen>
  );
}
