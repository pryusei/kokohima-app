import type { NotificationPreferences } from "@kokohima/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SendButton } from "../ui/Button";
import { Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { Section, SubScreen } from "../ui/Navigation";
import { Switch } from "../ui/Switch";
import { LockScreenPicker } from "../notifications/LockScreenPicker";
import { useUpdatePreferences } from "../notifications/preferences";
import { disablePush, enablePush, pushEnabled, pushSupported } from "../notifications/push";
import { preferencesQuery } from "../notifications/queries";

// 通知の設定（docs/specs/T-07-notification.md「お知らせ一覧」の「設定」、キャンバス「22 通知の設定」）
// ロック画面の見え方は docs/specs/T-35-notification-visibility.md「画面」

const CATEGORIES: { key: Exclude<keyof NotificationPreferences, "lockScreen">; label: string }[] = [
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
            <Note>ホーム画面に追加すると通知を受け取れます。追加しない場合はメールで届きます（LINEでログインした人はメールアドレスがないので、お知らせ一覧にだけ残ります）</Note>
            <Link to="/settings/install" className="text-s text-action underline">
              追加の方法
            </Link>
          </>
        )}
        {supported && enabled === false && (
          <SendButton variant="primary" block pending={toggle.isPending} onClick={() => toggle.mutate(true)}>
            この端末でプッシュ通知を受け取る
          </SendButton>
        )}
        {supported && enabled === true && (
          <SendButton block pending={toggle.isPending} onClick={() => toggle.mutate(false)}>
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
  const preferences = useQuery(preferencesQuery());
  const [failed, setFailed] = useState(false);
  const update = useUpdatePreferences(() => setFailed(true));

  return (
    <SubScreen title="通知の設定" back="/settings">
      <Section title="受け取るお知らせ">
        <Note>止めた種類は、プッシュ通知もメールも届かず、お知らせ一覧にだけ残ります。</Note>
        {preferences.data && (
          <div className="rounded-l bg-surface px-4 shadow-card">
            {CATEGORIES.map((c) => (
              <div key={c.key} className="border-b border-line last:border-b-0">
                <Switch
                  checked={preferences.data[c.key]}
                  onChange={(v) => {
                    setFailed(false);
                    update.mutate({ [c.key]: v });
                  }}
                >
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
        <Note>新しい端末でのログインのお知らせは止められません（メールで届きます。LINEでログインした人には、お知らせ一覧にだけ出します）</Note>
      </Section>
      <PushSection />
      <Section title="ロック画面">
        <div className="rounded-l bg-surface p-4 shadow-card">
          <LockScreenPicker />
        </div>
        <Note>断り・見送り・取り消しと、夜22時〜朝7時は鳴らさず、お知らせ一覧にだけ残します</Note>
      </Section>
    </SubScreen>
  );
}
