import { broadcastSchema, type Broadcast } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiSend, isIdempotencyConflict } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { broadcastStatusText, broadcastStatusTone, formatRange } from "../invitations/format";
import { MeetMoment, useMeetMoment } from "../invitations/MeetMoment";
import { broadcastQuery } from "../invitations/queries";
import { IcsButton } from "../calendar/IcsButton";
import { honorificOf, nameOfProfile } from "../account/me";
import { Avatar } from "../ui/Avatar";
import { Badge } from "../ui/Badge";
import { SheetScreen } from "../ui/BottomSheet";
import { ButtonLink, SendButton } from "../ui/Button";
import { FadeIn, LoadError, Loading, Note } from "../ui/feedback";
import { HeadCount } from "../ui/HeadCount";
import { LinkCard } from "../ui/LinkCard";
import { MoreButton, usePersonActionsToggle } from "../safety/MoreButton";
import { PersonActions } from "../safety/PersonActions";

// 募集の詳細（docs/specs/T-05-broadcast.md「画面」、キャンバス「14 募集の詳細」）。宛先の人には人数・名前・ほかの宛先を出さない
// 後ろに誘いタブを出したシートで開く（docs/specs/T-11-design.md「画面のつながり」）

type Action = "respond" | "withdraw" | "decide";

/** 「決める」だけ Idempotency-Key を付ける（応じる・やめるは何度送っても同じ。T-10） */
const request = (id: string, action: Action, idempotencyKey: (signature: string) => string) => {
  const base = `/api/v1/broadcasts/${encodeURIComponent(id)}`;
  if (action === "respond") return apiSend("POST", `${base}/responses`, undefined, broadcastSchema);
  if (action === "withdraw") return apiSend("DELETE", `${base}/responses/me`, undefined, broadcastSchema);
  const path = `${base}/decide`;
  return apiSend("POST", path, undefined, broadcastSchema, { idempotencyKey: idempotencyKey(signatureOf(path, undefined)) });
};

/** onDecided：自分の「決める」が成功して決まったとき（バッジの「ぽん」。M-04） */
function Actions({ b, onDecided }: { b: Broadcast; onDecided: () => void }) {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  const key = keys.broadcasts.detail(b.id);
  const idempotency = useIdempotencyKey();
  const act = useMutation({
    mutationFn: (action: Action) => request(b.id, action, idempotency.keyFor),
    onMutate: () => setFailed(null),
    onSuccess: (updated, action) => {
      if (updated) queryClient.setQueryData(key, updated);
      if (action === "decide" && updated?.status === "decided") onDecided();
    },
    onError: (error) => {
      // 409 なら最新の状態を読み直して表示する
      setFailed(
        error instanceof ApiError && error.status === 409 && !isIdempotencyConflict(error)
          ? "状態が変わっていました。最新の状態を表示しました"
          : "送れませんでした。もう一度お試しください",
      );
    },
    onSettled: async (_data, error) => {
      idempotency.settle(error);
      await queryClient.invalidateQueries({ queryKey: keys.broadcasts.all() });
      await queryClient.invalidateQueries({ queryKey: keys.meetups.all() });
    },
  });

  const button = (action: Action, label: string, primary = false) => (
    <SendButton variant={primary ? "primary" : "ghost"} block disabled={act.isPending} onClick={() => act.mutate(action)}>
      {label}
    </SendButton>
  );

  return (
    <div className="flex flex-col gap-3">
      {b.direction === "sent" && b.status === "open" && (
        <div className="flex flex-col gap-2 rounded-l bg-surface-sunken p-4">
          <HeadCount count={b.responseCount ?? 0} />
          <Note>誰が応じたかは、決めるまで表示されません</Note>
        </div>
      )}
      {b.direction === "sent" && b.status === "open" && (b.responseCount ?? 0) >= 1 && button("decide", "決める", true)}
      {b.direction === "sent" && b.status === "open" && (b.responseCount ?? 0) >= 1 && (
        <Note>決めると、参加する人どうしに名前が開示され、予定が成立します。</Note>
      )}
      {b.direction === "sent" && b.status === "expired" && (
        <ButtonLink to={`/broadcasts/new?from=${b.id}`} block>
          もう一度募集する
        </ButtonLink>
      )}
      {b.direction === "received" && b.status === "open" &&
        (b.respondedByMe ? button("withdraw", "応じるのをやめる") : button("respond", "応じる", true))}
      {b.direction === "received" && b.status === "open" && !b.respondedByMe && (
        <Note>応じても、募集した人には人数だけが伝わります。応じなければ、そのままで大丈夫です。</Note>
      )}
      {b.meetupId && (
        <ButtonLink to={`/meetups/${b.meetupId}`} variant="meet" block>
          成立した予定を見る
        </ButtonLink>
      )}
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          {failed}
        </p>
      )}
    </div>
  );
}

export function BroadcastDetailPage({ broadcastId }: { broadcastId: string }) {
  const broadcast = useQuery(broadcastQuery(broadcastId));
  // 届いた募集の「…」（相手への操作。docs/specs/T-33-block-report.md「振る舞い 1.」）
  const { acting, open: openActions, close: closeActions, moreRef } = usePersonActionsToggle();
  // 決めたあと、または決まったことを知って最初に開いた1回だけ、成立の演出を出す（docs/specs/T-43-meet-moment.md）
  const moment = useMeetMoment(broadcast.data?.status === "decided" ? broadcast.data.meetupId : null);
  // 自分の「決める」で決まったとき・成立の演出が流れるときだけ、バッジが「ぽん」とする（予定の参加者だけ。M-04）
  const [decidedByMe, setDecidedByMe] = useState(false);

  if (broadcast.error instanceof ApiError && broadcast.error.status === 404) {
    return (
      <SheetScreen title="暇な人いる？" label="募集" parent="/invites">
        <p role="status">この募集は見つかりませんでした。</p>
      </SheetScreen>
    );
  }
  const b = broadcast.data;
  const owner = b?.direction === "received" ? nameOfProfile(b.owner) : null;
  const ownerNamed = b?.direction === "received" ? honorificOf(b.owner) : null;

  return (
    <SheetScreen
      label={ownerNamed ? `${ownerNamed}の募集` : "暇な人いる？"}
      parent="/invites"
      title={
        <div className="flex items-center gap-3">
          {b?.direction === "received" && <Avatar name={b.owner.displayName} src={b.owner.avatarUrl} />}
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="truncate text-l font-bold">{ownerNamed ? `${ownerNamed}の募集` : "暇な人いる？"}</h2>
            {/* バッジは「暇な人いる？」の横（1行めに置くと、名前が数文字で切れる。入らなければ種類の文字の下へ折り返す。docs/specs/T-56-motion.md「V-1」） */}
            {(owner || b) && (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {owner && <span className="min-w-0 truncate text-s text-ink-muted">暇な人いる？</span>}
                {/* 募集者の募集中は、人数を下の HeadCount で大きく出すので、バッジは「募集中」だけにする */}
                {b && (
                  <Badge tone={broadcastStatusTone(b)} pop={decidedByMe || moment !== null}>
                    {b.direction === "sent" && b.status === "open" ? "募集中" : broadcastStatusText(b)}
                  </Badge>
                )}
              </span>
            )}
          </div>
          {b?.direction === "received" && owner && !b.owner.withdrawn && !acting && (
            <MoreButton ref={moreRef} name={owner} onClick={openActions} />
          )}
        </div>
      }
    >
      {acting && b?.direction === "received" && owner && (
        <PersonActions
          person={{ id: b.owner.id, name: owner }}
          subject={{ type: "broadcast", id: b.id }}
          onBack={closeActions}
          onDone={closeActions}
        />
      )}
      {broadcast.isPending && <Loading />}
      {broadcast.isError && !(broadcast.error instanceof ApiError && broadcast.error.status === 404) && (
        <LoadError retry={() => void broadcast.refetch()} />
      )}
      {b && !acting && (
        <FadeIn className="flex flex-col gap-4">
          <p className="text-ink-muted">
            {b.direction === "received" ? <>募集した人：{owner}</> : <>宛先：{b.recipients?.length ?? 0}人</>}
          </p>
          {moment ? (
            <MeetMoment meetup={moment}>
              <IcsButton meetupId={moment.id} />
            </MeetMoment>
          ) : (
            <div className="flex flex-col gap-1">
              <p className="text-xl font-bold tabular-nums">{formatRange(b)}</p>
              {b.area && <p className="text-ink-muted">エリア：{b.area}</p>}
            </div>
          )}
          {b.message && <p className="whitespace-pre-wrap">{b.message}</p>}
          <LinkCard url={b.url} preview={b.linkPreview} />
          <Actions b={b} onDecided={() => setDecidedByMe(true)} />
        </FadeIn>
      )}
    </SheetScreen>
  );
}
