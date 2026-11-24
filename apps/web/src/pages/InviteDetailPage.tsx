import { directInviteSchema, type DirectInvite } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { addDays, formatDate, formatTime, localDateOf, localInstant } from "../availability/format";
import { decideLabel, inviteTimes, KIND_LABELS, statusText, statusTone } from "../invitations/format";
import { inviteQuery } from "../invitations/queries";
import { honorificOf, nameOfProfile } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { SheetScreen } from "../ui/BottomSheet";
import { Button, SendButton } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { ResponseButtons } from "../ui/HeadCount";
import { Link } from "../ui/Link";
import { LinkCard } from "../ui/LinkCard";
import { MoreButton, usePersonActionsToggle } from "../safety/MoreButton";
import { PersonActions } from "../safety/PersonActions";

// 誘いの詳細と返答（docs/specs/T-04-direct-invite.md「画面」、キャンバス「12 受信した誘い」「12 この時間なら」「13 送信した誘い」）
// 後ろに誘いタブを出したシートで開く（docs/specs/T-11-design.md「画面のつながり」）

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
      className="flex flex-col gap-3 rounded-l bg-lamp-soft p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const startsAt = localInstant(date, start);
        let endsAt = localInstant(date, end);
        if (endsAt <= startsAt) endsAt = localInstant(addDays(date, 1), end);
        onSubmit(new Date(startsAt).toISOString(), new Date(endsAt).toISOString());
      }}
    >
      <p className="font-bold">別の時間を返す</p>
      <Field label="日付">
        <input type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <div className="flex items-end gap-2">
        <Field label="開始">
          <input type="time" step={900} className={inputClass} value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <span className="pb-2.5">〜</span>
        <Field label="終了">
          <input type="time" step={900} className={inputClass} value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
      </div>
      <SendButton type="submit" variant="primary">
        この時間で返す
      </SendButton>
    </form>
  );
}

export function InviteDetailPage({ inviteId }: { inviteId: string }) {
  const queryClient = useQueryClient();
  const invite = useQuery(inviteQuery(inviteId));
  const [failed, setFailed] = useState<string | null>(null);
  const [countering, setCountering] = useState(false);
  // 届いた誘いの「…」（相手への操作。docs/specs/T-33-block-report.md「振る舞い 1.」）
  const { acting, open: openActions, close: closeActions, moreRef } = usePersonActionsToggle();
  const key = keys.invites.detail(inviteId);

  // 返答・決定は押したらすぐ表示を変え、失敗したら戻して静かな文言を出す。409 なら最新の状態を読み直す
  const idempotency = useIdempotencyKey();
  const act = useMutation({
    mutationFn: (action: Action) => {
      const path = `/api/v1/direct-invites/${encodeURIComponent(inviteId)}/${action.path}`;
      return apiSend("POST", path, action.body, directInviteSchema, {
        idempotencyKey: idempotency.keyFor(signatureOf(path, action.body)),
      });
    },
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
        error instanceof ApiError && error.status === 409 && !isIdempotencyConflict(error)
          ? "この誘いはもう返事ができません。最新の状態を表示しました"
          : "送れませんでした。もう一度お試しください",
      );
    },
    onSuccess: (updated) => {
      if (updated) queryClient.setQueryData(key, updated);
    },
    onSettled: async (_data, error) => {
      idempotency.settle(error);
      await queryClient.invalidateQueries({ queryKey: keys.invites.all() });
      await queryClient.invalidateQueries({ queryKey: keys.meetups.all() });
    },
  });

  if (invite.error instanceof ApiError && invite.error.status === 404) {
    return (
      <SheetScreen title="誘い" label="誘い" parent="/invites">
        <p role="status">この誘いは見つかりませんでした。</p>
      </SheetScreen>
    );
  }
  const d = invite.data;
  const name = d ? nameOfProfile(d.counterpart) : "";
  const named = d ? honorificOf(d.counterpart) : "";
  const times = d ? inviteTimes(d) : null;

  return (
    <SheetScreen
      label={d ? `${named}${d.direction === "received" ? "からの誘い" : "への誘い"}` : "誘い"}
      parent="/invites"
      title={
        d ? (
          <div className="flex items-center gap-3">
            <Avatar name={d.counterpart.displayName} src={d.counterpart.avatarUrl} />
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="truncate text-l font-bold">{d.direction === "received" ? name : `${named}へ`}</h2>
              <span className="truncate text-s text-ink-muted">{KIND_LABELS[d.kind]}</span>
            </div>
            <Badge tone={statusTone(d.status)}>{statusText(d)}</Badge>
            {d.direction === "received" && !d.counterpart.withdrawn && !acting && (
              <MoreButton ref={moreRef} name={name} onClick={openActions} />
            )}
          </div>
        ) : (
          <h2 className="text-xl font-bold">誘い</h2>
        )
      }
    >
      {acting && d && (
        <PersonActions
          person={{ id: d.counterpart.id, name }}
          subject={{ type: "direct_invite", id: d.id }}
          onBack={closeActions}
          onDone={closeActions}
        />
      )}
      {invite.isPending && <Loading />}
      {invite.isError && !(invite.error instanceof ApiError && invite.error.status === 404) && (
        <LoadError retry={() => void invite.refetch()} />
      )}
      {d && !acting && (
        <>
          <p className="sr-only">
            {d.direction === "received" ? "誘ってくれた人" : "誘った相手"}：{name}
          </p>
          <div className="flex flex-col gap-1">
            <p className="text-xl font-bold tabular-nums">{times?.when}</p>
            {times?.original && <p className="text-s text-ink-muted tabular-nums">{times.original}</p>}
            {d.area && <p className="text-ink-muted">エリア：{d.area}</p>}
          </div>
          {d.message && <p className="whitespace-pre-wrap">{d.message}</p>}
          <LinkCard url={d.url} preview={d.linkPreview} />
          {d.status === "pending" && (
            <Note>
              返事の期限：{formatDate(localDateOf(d.expiresAt))} {formatTime(d.expiresAt)}
            </Note>
          )}
          {d.meetupId && (
            <Link to={`/meetups/${d.meetupId}`} className="text-action underline">
              成立した予定を見る
            </Link>
          )}

          {d.direction === "received" && d.status === "pending" && (
            <div className="flex flex-col gap-3">
              <ResponseButtons>
                <SendButton variant="primary" onClick={() => act.mutate({ path: "responses", body: { response: "accept" } })}>
                  行く
                </SendButton>
                <SendButton onClick={() => act.mutate({ path: "responses", body: { response: "decline" } })}>
                  今回は難しい
                </SendButton>
                <Button aria-pressed={countering} onClick={() => setCountering((v) => !v)}>
                  この時間なら
                </Button>
              </ResponseButtons>
              <Note>「今回は難しい」を選んでも、理由は伝わりません。</Note>
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
            <div className="flex flex-col gap-3">
              <ResponseButtons>
                <SendButton variant="primary" onClick={() => act.mutate({ path: "decide", body: { decision: "accept" } })}>
                  {d.counterProposal ? decideLabel(d.counterProposal) : "決める"}
                </SendButton>
                <SendButton onClick={() => act.mutate({ path: "decide", body: { decision: "skip" } })}>
                  見送る
                </SendButton>
              </ResponseButtons>
              <Note>見送っても、相手には「見送りになりました」とだけ伝わります。</Note>
            </div>
          )}
          {failed && (
            <p role="status" className="text-s text-ink-muted">
              {failed}
            </p>
          )}
        </>
      )}
    </SheetScreen>
  );
}
