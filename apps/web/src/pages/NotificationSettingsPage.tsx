import type { NotificationPreferences } from "@kokohima/shared";
import { notificationPreferencesSchema } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { Nav } from "../components/Nav";
import { disablePush, enablePush, pushEnabled, pushSupported } from "../notifications/push";
import { preferencesQuery } from "../notifications/queries";

// 通知の設定（仮。docs/specs/T-07-notification.md「お知らせ一覧」の「設定」）

const CATEGORIES: { key: keyof NotificationPreferences; label: string }[] = [
  { key: "invites", label: "誘い" },
  { key: "broadcasts", label: "募集" },
  { key: "meetups", label: "予定" },
  { key: "friends", label: "友達" },
  { key: "calendar", label: "カレンダー" },
];

function PushSection() {
  const supported = pushSupported();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void pushEnabled()
      .catch(() => false)
      .then((v) => {
        if (!cancelled) setEnabled(v);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) return enablePush();
      await disablePush();
      return false;
    },
    onMutate: () => setMessage(null),
    onSuccess: (now, wanted) => {
      setEnabled(now);
      if (wanted && !now) setMessage("通知が許可されていません。端末の設定で許可すると受け取れます");
    },
    onError: () => setMessage("変更できませんでした。もう一度お試しください"),
  });

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-bold">この端末のプッシュ通知</h2>
      {!supported && (
        <p className="text-slate-600">ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます</p>
      )}
      {supported && enabled === false && (
        <button
          type="button"
          className="self-start rounded-lg bg-amber-300 px-4 py-2"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(true)}
        >
          この端末でプッシュ通知を受け取る
        </button>
      )}
      {supported && enabled === true && (
        <button
          type="button"
          className="self-start rounded-lg border border-slate-300 px-4 py-2"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(false)}
        >
          この端末でのプッシュ通知をやめる
        </button>
      )}
      {message && (
        <p role="status" className="text-sm text-slate-600">
          {message}
        </p>
      )}
    </section>
  );
}

export function NotificationSettingsPage() {
  const queryClient = useQueryClient();
  const preferences = useQuery(preferencesQuery());
  const [failed, setFailed] = useState(false);

  const update = useMutation({
    mutationFn: (patch: Partial<NotificationPreferences>) =>
      apiSend("PATCH", "/api/v1/me/notification-preferences", patch, notificationPreferencesSchema),
    onMutate: async (patch) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: keys.notifications.preferences() });
      const previous = queryClient.getQueryData<NotificationPreferences>(keys.notifications.preferences());
      queryClient.setQueryData<NotificationPreferences>(keys.notifications.preferences(), (p) => p && { ...p, ...patch });
      return { previous };
    },
    onError: (_err, _patch, context) => {
      setFailed(true);
      if (context?.previous) queryClient.setQueryData(keys.notifications.preferences(), context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.notifications.preferences() }),
  });

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">通知の設定</h1>
      <Nav />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">受け取るお知らせ</h2>
        <p className="text-sm text-slate-600">
          止めた種類は、プッシュ通知もメールも届かず、お知らせ一覧にだけ残ります。
        </p>
        {preferences.data &&
          CATEGORIES.map((c) => (
            <label key={c.key} className="flex items-center justify-between gap-4">
              <span>{c.label}</span>
              <input
                type="checkbox"
                role="switch"
                checked={preferences.data[c.key]}
                onChange={(e) => update.mutate({ [c.key]: e.target.checked })}
              />
            </label>
          ))}
        {failed && (
          <p role="status" className="text-sm text-slate-600">
            変更できませんでした。もう一度お試しください
          </p>
        )}
        <p className="text-sm text-slate-600">新しい端末でのログインのお知らせは止められません</p>
      </section>
      <PushSection />
    </main>
  );
}
