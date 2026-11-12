import { calendarAuthorizationSchema, type CalendarConnectionStatus } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { connectionsQuery } from "../calendar/queries";
import { Nav } from "../components/Nav";

// 設定のカレンダー連携（仮。docs/specs/T-06-calendar.md「画面」）。失敗は赤を使わず静かに出す

const STATUS_TEXT: Record<CalendarConnectionStatus, string> = {
  none: "連携していません",
  connected: "連携中",
  needs_reauth: "もう一度連携してください",
};

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
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">カレンダー連携</h1>
      <Nav />
      {result && RESULT_TEXT[result] && (
        <p role="status" className="text-slate-600">
          {RESULT_TEXT[result]}
        </p>
      )}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">Googleカレンダー</h2>
        <p className="text-sm text-slate-600">
          読むのは空き／埋まりだけで、予定のタイトル・場所・参加者は読みません。成立した予定は「ここ暇」カレンダーに書き込みます。
        </p>
        {status && <p>{STATUS_TEXT[status]}</p>}
        {status && status !== "connected" && (
          <button type="button" className="self-start rounded-lg bg-amber-300 px-4 py-2" onClick={() => connect.mutate()}>
            Googleカレンダーと連携
          </button>
        )}
        {status && status !== "none" && (
          <button type="button" className="self-start rounded-lg border px-4 py-2" onClick={() => disconnect.mutate()}>
            連携をやめる
          </button>
        )}
        {failed && (
          <p role="status" className="text-sm text-slate-600">
            {failed === "connect" ? "連携を始められませんでした。" : "連携をやめられませんでした。"}
            もう一度お試しください
          </p>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-bold">Appleカレンダー</h2>
        <p className="text-slate-600">Appleカレンダーは準備中です。成立した予定は .ics で追加できます</p>
      </section>
    </main>
  );
}
