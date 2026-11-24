import { directInviteSchema, type DirectInvite } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { addDays, formatDate, formatTime, localDateOf, localInstant } from "../availability/format";
import { decideLabel, inviteTimes, KIND_LABELS, statusText, statusTone } from "../invitations/format";
import { MeetMoment, useMeetMoment } from "../invitations/MeetMoment";
import { inviteQuery } from "../invitations/queries";
import { IcsButton } from "../calendar/IcsButton";
import { honorificOf, nameOfProfile } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { SheetScreen } from "../ui/BottomSheet";
import { Button, ButtonLink, SendButton } from "../ui/Button";
import { Collapse } from "../ui/Collapse";
import { FadeIn, LoadError, Loading, Note } from "../ui/feedback";
import { Field, inputClass } from "../ui/form";
import { ResponseButtons } from "../ui/HeadCount";
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
  // 自分の操作（「行く」・「決める」）で成立に変わったか。バッジの「ぽん」はこのときだけ（取り直しで相手の操作により変わったときは動かさない。M-04）
  const [metByMe, setMetByMe] = useState(false);
  // 届いた誘いの「…」（相手への操作。docs/specs/T-33-block-report.md「振る舞い 1.」）
  const { acting, open: openActions, close: closeActions, moreRef } = usePersonActionsToggle();
  const key = keys.invites.detail(inviteId);
  // 成立した（行く・決める）あと、または成立を知って最初に開いた1回だけ、成立の演出を出す（docs/specs/T-43-meet-moment.md）。
  // 予定の ID はサーバーの応答で入るので、楽観的更新の間は流さない
  const moment = useMeetMoment(invite.data?.status === "confirmed" ? invite.data.meetupId : null);

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
      const status = optimisticStatus(action);
      if (status === "confirmed") setMetByMe(true);
      queryClient.setQueryData<DirectInvite>(key, (d) => d && { ...d, status });
      return { previous };
    },
    onError: (error, _action, context) => {
      // 送れなかったら元のバッジに戻す（戻るのは動かさない）。返答のボタン群は Collapse で元の場所に開いて戻る
      setMetByMe(false);
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
              {/* バッジは種類の文字の横（1行めに置くと、名前が数文字で切れる。入らなければ種類の文字の下へ折り返す。docs/specs/T-56-motion.md「V-1」） */}
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="min-w-0 truncate text-s text-ink-muted">{KIND_LABELS[d.kind]}</span>
                <Badge tone={statusTone(d.status)} pop={metByMe || moment !== null}>
                  {statusText(d)}
                </Badge>
              </span>
            </div>
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
        <FadeIn className="flex flex-col gap-4">
          <p className="sr-only">
            {d.direction === "received" ? "誘ってくれた人" : "誘った相手"}：{name}
          </p>
          {moment ? (
            <MeetMoment meetup={moment}>
              <IcsButton meetupId={moment.id} />
            </MeetMoment>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-xl font-bold tabular-nums">{times?.when}</p>
              {times?.original && <p className="text-s text-ink-muted tabular-nums">{times.original}</p>}
              {d.area && <p className="text-ink-muted">エリア：{d.area}</p>}
            </div>
          )}
          {d.message && <p className="whitespace-pre-wrap">{d.message}</p>}
          <LinkCard url={d.url} preview={d.linkPreview} />
          {d.status === "pending" && (
            <Note>
              返事の期限：{formatDate(localDateOf(d.expiresAt))} {formatTime(d.expiresAt)}
            </Note>
          )}
          {d.meetupId && (
            <ButtonLink to={`/meetups/${d.meetupId}`} variant="meet" block>
              成立した予定を見る
            </ButtonLink>
          )}

          {/* 返答・決定のボタン群は、押して状態が変わったら縮んで消える（「今回は難しい」「見送る」も同じ静かな動き。M-04）。
              シートの gap を打ち消し、開いている間だけ中身の上の余白で間を取る */}
          {d.direction === "received" && (
            <div className="-mt-4">
              <Collapse show={d.status === "pending"}>
                <div className="kh-collapse-shrink flex flex-col gap-3 pt-4">
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
              </Collapse>
            </div>
          )}

          {d.direction === "sent" && (
            <div className="-mt-4">
              <Collapse show={d.status === "counter_proposed"}>
                <div className="kh-collapse-shrink flex flex-col gap-3 pt-4">
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
              </Collapse>
            </div>
          )}
          {failed && (
            <p role="status" className="text-s text-ink-muted">
              {failed}
            </p>
          )}
        </FadeIn>
      )}
    </SheetScreen>
  );
}
