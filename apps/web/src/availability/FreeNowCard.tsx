import { myAvailabilitySchema, type MyAvailability } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { SendButton } from "../ui/Button";
import { MOTION_MS, useExitAnimation } from "../ui/motion";
import { useOnline } from "../ui/online";
import { formatTime, formatUntil, freeNowRange } from "./format";
import { mineQuery, today } from "./queries";
import { useNow } from "./useNow";

// 今ひま（docs/specs/T-40-ima-hima.md）。「みんな」の一番上の大きな灯りのボタン（モックの案A）。
// 押すと確認なしで、今（15分で切り上げ）から3時間のここ暇を作る。友達へ通知はしない。
// 作り方は既存のここ暇（POST /api/v1/availabilities）と同じで、見せる／見せないもそのまま効く。

type MyList = { items: MyAvailability[]; nextCursor: null };

/** 「元に戻す」と「おしまい」を出しておく長さ */
export const FREE_NOW_NOTICE_MS = 5_000;

const PATH = "/api/v1/availabilities";

type Notice =
  | { kind: "stopped"; startsAt: string }
  | { kind: "ended"; id: string; endsAt: string }
  | { kind: "message"; text: string };

/** その時刻までのミリ秒（過ぎていれば0） */
const msUntil = (instant: string) => Math.max(0, Date.parse(instant) - Date.now());

function lightErrorText(error: unknown) {
  if (error instanceof ApiError && error.status === 409) return "この時間には、もうほかのここ暇があります";
  return "灯せませんでした。通信状態を確認して、もう一度お試しください";
}

export function FreeNowCard() {
  const queryClient = useQueryClient();
  // 時刻は30秒ごとに描き直す（灯りのボタンの目安の時刻。この部品の中だけで持ち、「みんな」全体を描き直さない）
  const now = useNow();
  // 自分の一覧の日付は開いたときのまま持つ。0:00 をまたいでキーが変わると、日付をまたぐ今ひまが消えて見えるため
  const [date] = useState(today);
  const mineKey = keys.availability.mine(date);
  const mine = useQuery(mineQuery(date));
  const online = useOnline();
  const [notice, setNotice] = useState<Notice | null>(null);
  // 終わりの時刻が来た今ひまのID。「おしまい」の表示が消えたあとも覚えておき、
  // 取り直しが遅れた・失敗した・端末の時計が進んでいるときに、終わった今ひまを灯った表示に戻さない
  const [endedIds, setEndedIds] = useState<ReadonlySet<string>>(() => new Set());

  const active = mine.data?.items.find(
    (i) =>
      i.source === "manual" &&
      i.freeNow &&
      Date.parse(i.endsAt) > now &&
      !endedIds.has(i.id),
  );

  // 作った枠はすぐ一覧のキャッシュに入れ（ボタンをすぐ「今ひま」に変える）、「みんな」の重なりの印は取り直す
  const remember = (item: MyAvailability) =>
    queryClient.setQueryData<MyList>(mineKey, (list) =>
      list && { ...list, items: [...list.items.filter((i) => i.id !== item.id), item].sort((a, b) => a.startsAt.localeCompare(b.startsAt)) },
    );
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.availability.all() });

  const lightKey = useIdempotencyKey();
  const light = useMutation({
    mutationFn: () => {
      const body = { freeNow: true };
      return apiSend("POST", PATH, body, myAvailabilitySchema, { idempotencyKey: lightKey.keyFor(signatureOf(PATH, body)) });
    },
    onMutate: () => setNotice(null),
    onSuccess: (item) => item && remember(item),
    onError: (error) => setNotice({ kind: "message", text: lightErrorText(error) }),
    onSettled: (_data, error) => {
      lightKey.settle(error);
      return refresh();
    },
  });

  // やめる：押したらすぐ消し（楽観的更新）、数秒「元に戻す」を出す。失敗したら元に戻して静かな文言
  const stop = useMutation({
    mutationFn: (item: MyAvailability) => apiSend("DELETE", `${PATH}/${item.id}`, undefined),
    onMutate: async (item) => {
      await queryClient.cancelQueries({ queryKey: mineKey });
      const previous = queryClient.getQueryData<MyList>(mineKey);
      queryClient.setQueryData<MyList>(mineKey, (list) => list && { ...list, items: list.items.filter((i) => i.id !== item.id) });
      setNotice({ kind: "stopped", startsAt: item.startsAt });
      return { previous };
    },
    onError: (_error, _item, context) => {
      if (context?.previous) queryClient.setQueryData(mineKey, context.previous);
      setNotice({ kind: "message", text: "やめられませんでした。もう一度お試しください" });
    },
    onSettled: refresh,
  });

  // 元に戻す：やめた今ひまと同じ開始で作り直す（時刻の検証はサーバー）
  const restoreKey = useIdempotencyKey();
  const restore = useMutation({
    mutationFn: (startsAt: string) => {
      const body = { freeNow: true, startsAt };
      return apiSend("POST", PATH, body, myAvailabilitySchema, { idempotencyKey: restoreKey.keyFor(signatureOf(PATH, body)) });
    },
    onSuccess: (item) => {
      if (item) remember(item);
      setNotice(null);
    },
    onError: () => setNotice({ kind: "message", text: "元に戻せませんでした" }),
    onSettled: (_data, error) => {
      restoreKey.settle(error);
      return refresh();
    },
  });

  // 時間が来たら静かに「おしまい」にする（友達の一覧と重なりの印も取り直す）
  const activeId = active?.id;
  const activeEnd = active?.endsAt;
  useEffect(() => {
    if (!activeId || !activeEnd) return;
    const id = setTimeout(
      () => {
        setEndedIds((ids) => new Set(ids).add(activeId));
        setNotice({ kind: "ended", id: activeId, endsAt: activeEnd });
        // 終わった枠は自分の一覧のキャッシュからも外す（取り直しを待たずに灯りのボタンへ戻せるように）
        queryClient.setQueryData<MyList>(keys.availability.mine(date), (list) => list && { ...list, items: list.items.filter((i) => i.id !== activeId) });
        void queryClient.invalidateQueries({ queryKey: keys.availability.all() });
      },
      msUntil(activeEnd),
    );
    return () => clearTimeout(id);
  }, [activeId, activeEnd, queryClient, date]);

  // 「元に戻す」と「おしまい」は数秒で消し、灯りのボタンに戻す。元に戻す送信の途中は消さない（結果を待つ）。
  // 消えるときは fast のフェード（docs/specs/T-56-motion.md「M-09」）
  const noticeKind = notice?.kind;
  const restoring = restore.isPending;
  const { ref: fadeRef, exiting: fading, start: startFade, cancel: cancelFade } = useExitAnimation<HTMLElement>(MOTION_MS.fast);
  useEffect(() => {
    if (noticeKind !== "stopped" && noticeKind !== "ended") return;
    if (restoring) return;
    const id = setTimeout(() => startFade(() => setNotice(null)), FREE_NOW_NOTICE_MS);
    return () => {
      clearTimeout(id);
      cancelFade();
    };
  }, [notice, noticeKind, restoring, startFade, cancelFade]);

  const message = notice?.kind === "message" && (
    <p role="status" className="text-s text-ink-muted">
      {notice.text}
    </p>
  );

  if (active) {
    return (
      <section aria-label="今ひま" className="flex flex-col gap-2">
        <div className="flex items-center gap-3 rounded-l border border-lamp-line bg-lamp-soft px-4 py-3">
          <span aria-hidden="true" className="size-3 shrink-0 rounded-full bg-lamp shadow-lamp" />
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="font-bold tabular-nums">今ひま 〜{formatUntil(now, active.endsAt)}まで</p>
            <p className="text-s text-ink-muted">見せている友達に、時刻だけ出ています。通知はしていません</p>
          </div>
          <SendButton size="s" disabled={stop.isPending} onClick={() => stop.mutate(active)}>
            やめる
          </SendButton>
        </div>
        {message}
      </section>
    );
  }

  if (notice?.kind === "stopped" || notice?.kind === "ended") {
    return (
      <section
        ref={fadeRef}
        aria-label="今ひま"
        data-exiting={fading ? "" : undefined}
        className="kh-fade-exit flex animate-kh-rise items-center gap-3 rounded-l bg-quiet-bg px-4 py-3 text-quiet-ink"
      >
        <p role="status" className="min-w-0 flex-1">
          {notice.kind === "stopped" ? "今ひまをやめました" : `${formatTime(notice.endsAt)}で今ひまはおしまい`}
        </p>
        {notice.kind === "stopped" && (
          <SendButton
            variant="ghost"
            size="s"
            disabled={stop.isPending || restore.isPending}
            onClick={() => restore.mutate(notice.startsAt)}
          >
            元に戻す
          </SendButton>
        )}
      </section>
    );
  }

  const next = freeNowRange(now);
  return (
    <section aria-label="今ひま" className="flex flex-col gap-2">
      <button
        type="button"
        disabled={light.isPending || stop.isPending || restore.isPending || mine.isPending || !online}
        onClick={() => light.mutate()}
        className="flex w-full items-center gap-4 rounded-l bg-lamp px-4 py-4 text-left text-on-lamp shadow-lamp transition-transform duration-(--duration-press) ease-out active:scale-[.98] disabled:cursor-default disabled:bg-surface-sunken disabled:text-ink-disabled disabled:shadow-none disabled:active:scale-100"
      >
        <span aria-hidden="true" className="size-12 shrink-0 rounded-full border-4 border-lamp-soft bg-surface" />
        <span className="flex min-w-0 flex-col">
          <span className="text-l font-bold">今から3時間ひま</span>
          <span className="text-s tabular-nums">
            {formatTime(next.startsAt)}〜{formatUntil(next.startsAt, next.endsAt)} ・ 押すとすぐ灯る
          </span>
        </span>
      </button>
      {message}
    </section>
  );
}
