import { calendarAuthorizationSchema, type CalendarConnectionStatus } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { connectionsQuery } from "../calendar/queries";
import { Badge, type Tone } from "../ui/Badge";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Section, SubScreen } from "../ui/Navigation";
import { useResultBand } from "../ui/ResultBand";

// 設定のカレンダー連携（docs/specs/T-06-calendar.md「画面」、キャンバス「20 カレンダー連携」）。失敗は赤を使わず静かに出す

const STATUS_TEXT: Record<CalendarConnectionStatus, string> = {
  none: "連携していません",
  connected: "連携中",
  needs_reauth: "もう一度連携してください",
};

const STATUS_TONE: Record<CalendarConnectionStatus, Tone> = { none: "quiet", connected: "meet", needs_reauth: "lamp" };

const RESULT_TEXT: Record<string, string> = {
  connected: "連携しました",
  failed: "連携できませんでした。もう一度お試しください",
};

/** 外部の認可画面へ移る（テストで差し替える） */
export const redirectTo = { go: (url: string) => window.location.assign(url) };

export function CalendarSettingsPage({ search }: { search: string }) {
  const queryClient = useQueryClient();
  const connections = useQuery(connectionsQuery());
  const [failed, setFailed] = useState<"connect" | "disconnect" | null>(null);
  const result = new URLSearchParams(search).get("calendar");
  const status = connections.data?.google.status;
  // 連携の結果（?calendar=）は結果の帯に出す（docs/specs/T-56-motion.md「M-09」）。同じ結果は1回だけ
  const showBand = useResultBand();
  const shownResult = useRef<string | null>(null);
  useEffect(() => {
    const text = result ? RESULT_TEXT[result] : undefined;
    if (!text || shownResult.current === result) return;
    shownResult.current = result;
    showBand({ text });
  }, [result, showBand]);

  const connect = useMutation({
    mutationFn: () => apiSend("POST", "/api/v1/calendar/google/authorizations", undefined, calendarAuthorizationSchema),
    onMutate: () => setFailed(null),
    onSuccess: (data) => {
      if (data) redirectTo.go(data.authorizeUrl);
    },
    onError: () => setFailed("connect"),
  });

  const disconnect = useMutation({
    mutationFn: () => apiSend("DELETE", "/api/v1/calendar/connections/google", undefined),
    onMutate: () => setFailed(null),
    onError: () => setFailed("disconnect"),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.calendar.connections() });
      await queryClient.invalidateQueries({ queryKey: keys.availability.all() });
    },
  });

  return (
    <SubScreen title="カレンダー連携" back="/settings">
      <p>読むのは空き／埋まりだけで、予定のタイトル・場所・参加者は読みません。成立した予定は「ここ暇」カレンダーに書き込みます。</p>
      <Section title="Googleカレンダー">
        <div className="flex flex-col gap-3 rounded-l bg-surface p-4 shadow-card">
          {status && (
            <span className="self-start">
              <Badge tone={STATUS_TONE[status]}>{STATUS_TEXT[status]}</Badge>
            </span>
          )}
          {status && status !== "connected" && (
            <SendButton variant="primary" block onClick={() => connect.mutate()}>
              Googleカレンダーと連携
            </SendButton>
          )}
          {status && status !== "none" && (
            <SendButton block onClick={() => disconnect.mutate()}>
              連携をやめる
            </SendButton>
          )}
          {failed && (
            <p role="status" className="text-s text-ink-muted">
              {failed === "connect" ? "連携を始められませんでした。" : "連携をやめられませんでした。"}
              もう一度お試しください
            </p>
          )}
        </div>
      </Section>
      <Section title="Appleカレンダー">
        <Note>Appleカレンダーは準備中です。成立した予定は .ics で追加できます</Note>
      </Section>
    </SubScreen>
  );
}
