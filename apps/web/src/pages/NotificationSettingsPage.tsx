import type { NotificationPreferences } from "@kokohima/shared";
import { notificationPreferencesSchema } from "@kokohima/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiSend } from "../api/client";
import { keys } from "../api/keys";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { Section, SubScreen } from "../ui/Navigation";
import { Switch } from "../ui/Switch";
import { disablePush, enablePush, pushEnabled, pushSupported } from "../notifications/push";
import { preferencesQuery } from "../notifications/queries";

// 通知の設定（docs/specs/T-07-notification.md「お知らせ一覧」の「設定」、キャンバス「22 通知の設定」）

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
    <Section title="この端末のプッシュ通知">
      <div className="flex flex-col gap-3 rounded-l bg-surface p-4 shadow-card">
        {!supported && (
          <>
            <Note>ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます</Note>
            <Link to="/settings/install" className="text-s text-action underline">
              追加の方法
            </Link>
          </>
        )}
        {supported && enabled === false && (
          <SendButton variant="primary" block disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
            この端末でプッシュ通知を受け取る
          </SendButton>
        )}
        {supported && enabled === true && (
          <SendButton block disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
            この端末でのプッシュ通知をやめる
          </SendButton>
        )}
        {message && (
          <p role="status" className="text-s text-ink-muted">
            {message}
          </p>
        )}
      </div>
    </Section>
  );
}

export function NotificationSettingsPage() {
  const queryClient = useQueryClient();
  const preferences = useQuery(preferencesQuery());
  const [failed, setFailed] = useState(false);

  const prefKey = keys.notifications.preferences();
  const update = useMutation({
    mutationKey: prefKey,
    // PATCH は押した順に1つずつ送る（#116）。楽観的な表示（onMutate）はすぐ行う
    scope: { id: "notification-preferences" },
    mutationFn: (patch: Partial<NotificationPreferences>) =>
      apiSend("PATCH", "/api/v1/me/notification-preferences", patch, notificationPreferencesSchema),
    onMutate: async (patch) => {
      setFailed(false);
      await queryClient.cancelQueries({ queryKey: prefKey });
      const previous = queryClient.getQueryData<NotificationPreferences>(prefKey);
      queryClient.setQueryData<NotificationPreferences>(prefKey, (p) => p && { ...p, ...patch });
      return { previous };
    },
    onError: (_err, patch, context) => {
      setFailed(true);
      const previous = context?.previous;
      if (!previous) return;
      // この PATCH の項目だけを戻す。ほかのスイッチの楽観的な変更は消さない
      const revert = Object.fromEntries(
        (Object.keys(patch) as (keyof NotificationPreferences)[]).map((k) => [k, previous[k]]),
      );
      queryClient.setQueryData<NotificationPreferences>(prefKey, (p) => p && { ...p, ...revert });
    },
    onSettled: () => {
      // 後ろに送る PATCH が残っていれば、取り直しで楽観的な表示を古い値に戻さない。最後の1つで取り直す
      if (queryClient.isMutating({ mutationKey: prefKey }) === 1) {
        return queryClient.invalidateQueries({ queryKey: prefKey });
      }
    },
  });

  return (
    <SubScreen title="通知の設定" back="/settings">
      <Section title="受け取るお知らせ">
        <Note>止めた種類は、プッシュ通知もメールも届かず、お知らせ一覧にだけ残ります。</Note>
        {preferences.data && (
          <div className="rounded-l bg-surface px-4 shadow-card">
            {CATEGORIES.map((c) => (
              <div key={c.key} className="border-b border-line last:border-b-0">
                <Switch checked={preferences.data[c.key]} onChange={(v) => update.mutate({ [c.key]: v })}>
                  {c.label}
                </Switch>
              </div>
            ))}
          </div>
        )}
        {failed && (
          <p role="status" className="text-s text-ink-muted">
            変更できませんでした。もう一度お試しください
          </p>
        )}
        <Note>新しい端末でのログインのお知らせは止められません</Note>
      </Section>
      <PushSection />
    </SubScreen>
  );
}
