import { myAvailabilitySchema, type PresetName, type Presets } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiSend } from "../api/client";
import { signatureOf, useIdempotencyKey } from "../api/idempotency";
import { keys } from "../api/keys";
import { addDays, localDateOf, localInstant, PRESET_LABELS, PRESET_NAMES } from "../availability/format";
import { presetsQuery } from "../availability/queries";
import { enablePush, pushEnabled, pushSupported } from "../notifications/push";
import { navigate } from "../router";
import { Button, ButtonLink, SendButton } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { Section } from "../ui/Navigation";

// 友達になった直後の1画面（docs/specs/T-31-display-name-first-step.md「友達になった直後の1画面」）
// 「ここ暇を1つ出す」と「お知らせを受け取る」だけ。どちらも飛ばせる。説明の文はこの画面で1行だけ

/** 終わった（終了が現在時刻以前の）プリセット。終了の 24:00 は翌日の 0:00 */
const endedOn = (presets: Presets, date: string, now: number) => (name: PresetName) => {
  const end = presets[name].end;
  return (end === "24:00" ? localInstant(addDays(date, 1), "00:00") : localInstant(date, end)) <= now;
};

/** 今日のプリセットがすべて終わっていたら明日 */
export function firstStepDay(presets: Presets, now: number) {
  const date = localDateOf(now);
  const ended = endedOn(presets, date, now);
  if (PRESET_NAMES.every(ended)) return { date: addDays(date, 1), label: "明日", ended: () => false };
  return { date, label: "今日", ended };
}

function OneAvailability() {
  const queryClient = useQueryClient();
  const presets = useQuery(presetsQuery());
  // 画面を開いた時刻で、今日か明日か・終わったプリセットを決める
  const [openedAt] = useState(() => Date.now());
  const idempotency = useIdempotencyKey();
  const create = useMutation({
    mutationFn: (body: { date: string; preset: PresetName }) => {
      const path = "/api/v1/availabilities";
      return apiSend("POST", path, body, myAvailabilitySchema, { idempotencyKey: idempotency.keyFor(signatureOf(path, body)) });
    },
    onSettled: (_data, error) => idempotency.settle(error),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.availability.all() }),
  });

  if (!presets.data) {
    return (
      <Section title="ここ暇を1つ出す">
        {presets.isError ? <LoadError retry={() => void presets.refetch()} /> : <Loading />}
      </Section>
    );
  }
  const day = firstStepDay(presets.data, openedAt);
  return (
    <Section title={`${day.label}のここ暇を1つ出す`}>
      <div className="grid grid-cols-3 gap-2">
        {PRESET_NAMES.map((preset) => (
          <SendButton
            key={preset}
            variant="lamp"
            disabled={create.isPending || create.isSuccess || day.ended(preset)}
            className="min-h-16 flex-col gap-0"
            onClick={() => create.mutate({ date: day.date, preset })}
          >
            {PRESET_LABELS[preset]}
            <span className="text-s font-normal tabular-nums">
              {presets.data[preset].start}〜{presets.data[preset].end}
            </span>
          </SendButton>
        ))}
      </div>
      {create.isSuccess && (
        <p role="status" className="text-s text-ink-muted">
          出しました
        </p>
      )}
      {create.isError && (
        <p role="status" className="text-s text-ink-muted">
          出せませんでした。ここ暇タブから出してください。
        </p>
      )}
    </Section>
  );
}

function ReceiveNotifications() {
  const supported = pushSupported();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void pushEnabled()
      .catch(() => false)
      .then((v) => {
        if (!cancelled) setEnabled(v);
      });
    return () => {
      cancelled = true;
    };
  }, [supported]);

  // 許可の確認は、ボタンを押した操作の中で行う（T-07）
  const enable = useMutation({
    mutationFn: enablePush,
    onMutate: () => setMessage(null),
    onSuccess: (now) => {
      setEnabled(now);
      if (!now) setMessage("通知が許可されていません。端末の設定で許可すると受け取れます");
    },
    onError: () => setMessage("受け取れるようにできませんでした。設定の通知からお試しください。"),
  });

  return (
    <Section title="お知らせを受け取る">
      {!supported && (
        <ButtonLink to="/settings/install" block>
          ホーム画面に追加して、お知らせを受け取る
        </ButtonLink>
      )}
      {supported && enabled === true && (
        <p role="status" className="text-s text-ink-muted">
          この端末で受け取ります
        </p>
      )}
      {supported && enabled === false && (
        <SendButton variant="primary" block disabled={enable.isPending} onClick={() => enable.mutate()}>
          お知らせを受け取る
        </SendButton>
      )}
      {message && (
        <p role="status" className="text-s text-ink-muted">
          {message}
        </p>
      )}
    </Section>
  );
}

export function WelcomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-12">
      <p className="font-bold text-ink-muted">ここ暇</p>
      <h1 className="text-xl font-bold">友達になりました</h1>
      <Note>どちらも、あとで設定からできます。</Note>
      <OneAvailability />
      <ReceiveNotifications />
      <Button block onClick={() => navigate("/friends", { replace: true })}>
        友達の一覧へ
      </Button>
    </main>
  );
}
