import {
  friendSchema,
  REPORT_DETAILS_MAX,
  REPORT_REASON_LABELS,
  REPORT_REASONS,
  contactBodyLength,
  type Friend,
  type ReportReason,
  type SafetySubject,
} from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { Button, SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { CharCount, Chip, ChipRow, Field, textareaClass } from "../ui/form";
import { Switch } from "../ui/Switch";
import { isSafetyOpenNow } from "./open";

// 相手への操作のシート（「…」。docs/specs/T-33-block-report.md「振る舞い 1.」）。友達の詳細・届いた誘い・届いた募集の、
// 同じシートの中身を置き換えて出す。軽い順に：見せる／見せない → 友達を解除 → ブロック → 通報。
// どれを選んでも相手には知らせない。結果は静かに出す（赤・エラー色・Toast は使わない）。説明の文は1画面1行まで

export type PersonActionsResult = "unfriended" | "blocked" | "reported";

type Props = {
  person: { id: string; name: string };
  /** 届いた誘い・募集から開いたとき。通報にその中身を一緒に送り、友達でなくてもブロック・通報できる */
  subject?: SafetySubject;
  /** 「戻る」。元の中身に戻す */
  onBack: () => void;
  /** 終わったあとの「閉じる」。結果（解除した・ブロックした・通報した）で、呼び出し側が移る先を決める */
  onDone: (result: PersonActionsResult) => void;
};

/** 今の友達か（GET /friends/{id}）。404 なら友達でない（見せる・解除を出さない） */
function useFriendship(id: string) {
  return useQuery({
    queryKey: keys.friends.status(id),
    queryFn: async () => {
      try {
        return await apiGet(`/api/v1/friends/${encodeURIComponent(id)}`, friendSchema);
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
  });
}

/** 友達でなくなったあとに読み直すもの（友達の解除と同じ） */
function useForget() {
  const queryClient = useQueryClient();
  return (id: string) => {
    queryClient.removeQueries({ queryKey: keys.friends.detail(id) });
    queryClient.setQueryData(keys.friends.status(id), null);
    void queryClient.invalidateQueries({ queryKey: keys.friends.all() });
    void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
    void queryClient.invalidateQueries({ queryKey: keys.wishes.all() });
    void queryClient.invalidateQueries({ queryKey: ["blocks"] });
  };
}

const failedText = "できませんでした。もう一度お試しください。";

export function PersonActions(props: Props) {
  // 「…」は開くと消えるので、中身を置き換えるたびに、この領域へフォーカスを移す（読み上げにも置き換わったことが伝わる）
  const region = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"menu" | "report">("menu");
  const [done, setDone] = useState<null | { result: PersonActionsResult; text: string }>(null);
  useEffect(() => {
    region.current?.focus();
  }, [view, done]);
  return (
    <div ref={region} tabIndex={-1} role="group" aria-label={`${props.person.name}さんへの操作`}>
      <PersonActionsBody {...props} view={view} setView={setView} done={done} setDone={setDone} />
    </div>
  );
}

function PersonActionsBody({
  person,
  subject,
  onBack,
  onDone,
  view,
  setView,
  done,
  setDone,
}: Props & {
  view: "menu" | "report";
  setView: (v: "menu" | "report") => void;
  done: null | { result: PersonActionsResult; text: string };
  setDone: (d: { result: PersonActionsResult; text: string }) => void;
}) {
  if (done) {
    return (
      <div role="status" className="flex flex-col gap-3">
        <p>{done.text}</p>
        <Button block onClick={() => onDone(done.result)}>
          戻る
        </Button>
      </div>
    );
  }
  if (view === "report") {
    return (
      <ReportForm
        person={person}
        subject={subject}
        onBack={() => setView("menu")}
        onSent={(alsoBlock) =>
          setDone({ result: alsoBlock ? "blocked" : "reported", text: alsoBlock ? "送りました。ブロックもしました。" : "送りました。" })
        }
      />
    );
  }
  return (
    <Menu
      person={person}
      subject={subject}
      onBack={onBack}
      onReport={() => setView("report")}
      onFinished={(result) => setDone({ result, text: result === "blocked" ? "ブロックしました。" : "友達を解除しました。" })}
    />
  );
}

function Menu({
  person,
  subject,
  onBack,
  onReport,
  onFinished,
}: {
  person: { id: string; name: string };
  subject?: SafetySubject;
  onBack: () => void;
  onReport: () => void;
  onFinished: (result: "unfriended" | "blocked") => void;
}) {
  const queryClient = useQueryClient();
  const forget = useForget();
  const friendship = useFriendship(person.id);
  const friend = friendship.data ?? null;
  const [confirming, setConfirming] = useState<null | "unfriend" | "block">(null);
  const [failed, setFailed] = useState(false);
  const open = isSafetyOpenNow();

  const toggle = useMutation({
    mutationFn: (sharesMyAvailability: boolean) => apiSend("PATCH", `/api/v1/friends/${person.id}`, { sharesMyAvailability }),
    onMutate: async (sharesMyAvailability) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.friends.status(person.id) });
      const previous = queryClient.getQueryData<Friend | null>(keys.friends.status(person.id));
      queryClient.setQueryData<Friend | null>(keys.friends.status(person.id), (f) => f && { ...f, sharesMyAvailability });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(keys.friends.status(person.id), context.previous);
      setFailed(true);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.friends.all() }),
  });

  const unfriend = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/v1/friends/${person.id}`, undefined),
    onMutate: () => setFailed(false),
    onSuccess: () => {
      forget(person.id);
      onFinished("unfriended");
    },
    onError: () => setFailed(true),
  });

  const block = useMutation({
    mutationFn: () => apiSend("POST", "/api/v1/blocks", subject ? { userId: person.id, subject } : { userId: person.id }),
    onMutate: () => setFailed(false),
    onSuccess: () => {
      forget(person.id);
      onFinished("blocked");
    },
    onError: () => setFailed(true),
  });

  // 説明の文は1行だけ。確かめている間は、その操作の説明に置き換える
  const line =
    confirming === "block"
      ? `${person.name}さんには知らせません。友達の解除と同じになり、招待リンクでもつながらなくなります。`
      : `どれを選んでも${person.name}さんには知らせません。`;

  return (
    <div className="flex flex-col gap-4">
      <Note>{line}</Note>
      {friend && (
        <Switch checked={friend.sharesMyAvailability} onChange={(v) => toggle.mutate(v)}>
          自分の暇を見せる
        </Switch>
      )}
      {friend && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          {confirming === "unfriend" ? (
            <>
              <SendButton block onClick={() => unfriend.mutate()} disabled={unfriend.isPending}>
                {person.name}さんとの友達を解除する
              </SendButton>
              <Button variant="ghost" block onClick={() => setConfirming(null)}>
                やめる
              </Button>
            </>
          ) : (
            <Button variant="ghost" block onClick={() => setConfirming("unfriend")} disabled={confirming !== null}>
              友達を解除
            </Button>
          )}
        </div>
      )}
      {open && (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          {confirming === "block" ? (
            <>
              <SendButton block onClick={() => block.mutate()} disabled={block.isPending}>
                {person.name}さんをブロックする
              </SendButton>
              <Button variant="ghost" block onClick={() => setConfirming(null)}>
                やめる
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" block onClick={() => setConfirming("block")} disabled={confirming !== null}>
                ブロック
              </Button>
              <Button variant="ghost" block onClick={onReport} disabled={confirming !== null}>
                通報
              </Button>
            </>
          )}
        </div>
      )}
      {failed && (
        <p role="status" className="text-s text-ink-muted">
          {failedText}
        </p>
      )}
      <Button variant="ghost" block onClick={onBack}>
        戻る
      </Button>
    </div>
  );
}

/** 通報のフォーム（「振る舞い 4.」）。理由を選ぶだけで送れる。「ブロックもする」は最初から印 */
function ReportForm({
  person,
  subject,
  onBack,
  onSent,
}: {
  person: { id: string; name: string };
  subject?: SafetySubject;
  onBack: () => void;
  onSent: (alsoBlock: boolean) => void;
}) {
  const forget = useForget();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState("");
  const [alsoBlock, setAlsoBlock] = useState(true);
  const idempotency = useIdempotencyKey();
  const length = contactBodyLength(details);

  const send = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiSend("POST", "/api/v1/reports", body, undefined, { idempotencyKey: idempotency.keyFor(signatureOf("/api/v1/reports", body)) }),
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: (_data, body) => {
      if (body.alsoBlock) forget(person.id);
      onSent(body.alsoBlock === true);
    },
  });

  const sendable = reason !== null && length <= REPORT_DETAILS_MAX && !send.isPending;
  const failure =
    send.error instanceof ApiError && send.error.status === 401
      ? null
      : send.error instanceof ApiError && send.error.status === 429
        ? "今日はこれ以上送れません。ブロックは、前の画面からできます。"
        : send.isError
          ? "送れませんでした。もう一度お試しください。"
          : null;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason === null || !sendable) return;
        send.mutate({
          userId: person.id,
          reason,
          alsoBlock,
          ...(length > 0 ? { details } : {}),
          ...(subject ? { subject } : {}),
        });
      }}
    >
      <h3 className="text-l font-bold">{person.name}さんを通報</h3>
      <ChipRow label="理由">
        {REPORT_REASONS.map((r) => (
          <Chip key={r} selected={reason === r} onClick={() => setReason(r)}>
            {REPORT_REASON_LABELS[r]}
          </Chip>
        ))}
      </ChipRow>
      <div className="flex flex-col gap-1">
        <Field label="くわしく（なくても送れます）">
          <textarea className={textareaClass} rows={4} value={details} onChange={(e) => setDetails(e.target.value)} />
        </Field>
        <CharCount count={length} max={REPORT_DETAILS_MAX} />
      </div>
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" className="size-5 accent-action" checked={alsoBlock} onChange={(e) => setAlsoBlock(e.target.checked)} />
        ブロックもする
      </label>
      <Note>危ないと感じたら、周りの大人か #9110 へ。急ぐときは110番</Note>
      {failure && (
        <p role="status" className="text-s text-ink-muted">
          {failure}
        </p>
      )}
      <SendButton type="submit" variant="primary" block disabled={!sendable}>
        運営に送る
      </SendButton>
      <Button variant="ghost" block onClick={onBack}>
        戻る
      </Button>
    </form>
  );
}
