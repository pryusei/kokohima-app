import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { presetsQuery } from "../availability/queries";
import { useAuth } from "../auth/AuthProvider";
import { connectionsQuery } from "../calendar/queries";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { Section, SubScreen } from "../ui/Navigation";
import { useOnline } from "../ui/online";
import { PresetForm } from "./AvailabilityPage";
import { DisplayNameForm, meQuery } from "./FriendsPage";

// 設定（docs/specs/T-11-design.md「画面のつながり」、キャンバス「19 設定」「21 時間帯プリセット」「23 アカウント」）
// 友達タブの「アカウント」の節から開く。初回設定・退会・ログインの方法の連携は、それぞれのタスクで作る（#43・#37・#45）

function Row({ to, label, value }: { to: string; label: string; value?: string }) {
  return (
    <li className="border-b border-line last:border-b-0">
      <Link to={to} className="flex min-h-12 items-center gap-2 text-ink no-underline">
        <span className="flex-1">{label}</span>
        {value && <span className="text-s text-ink-muted">{value}</span>}
        <span aria-hidden="true" className="text-ink-muted">
          ›
        </span>
      </Link>
    </li>
  );
}

const CALENDAR_STATUS = { none: "連携していません", connected: "Google 連携中", needs_reauth: "もう一度連携してください" } as const;

export function SettingsPage() {
  const me = useQuery(meQuery());
  const calendar = useQuery(connectionsQuery());
  const status = calendar.data?.google.status;
  return (
    <SubScreen title="設定" back="/friends">
      <div className="flex items-center gap-4 py-2">
        <Avatar name={me.data?.displayName ?? null} size="l" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-l font-bold">{me.data ? (me.data.displayName ?? "表示名は未設定です") : ""}</span>
          <Link to="/settings/account" className="text-s text-action underline">
            表示名を変える
          </Link>
        </div>
      </div>
      <ul className="rounded-l bg-surface px-4 shadow-card">
        <Row to="/settings/calendar" label="カレンダー連携" value={status ? CALENDAR_STATUS[status] : undefined} />
        <Row to="/settings/presets" label="時間帯プリセット" value="昼・夕方・夜" />
        <Row to="/settings/notifications" label="通知の設定" />
        <Row to="/settings/account" label="アカウント" />
      </ul>
    </SubScreen>
  );
}

export function PresetSettingsPage() {
  const presets = useQuery(presetsQuery());
  return (
    <SubScreen title="時間帯プリセット" back="/settings">
      <p>「昼」「夕方」「夜」を押したときの時刻です。自分の生活に合わせて変えられます。</p>
      {presets.isPending && <Loading />}
      {presets.isError && <LoadError retry={() => void presets.refetch()} />}
      {presets.data && (
        <div className="rounded-l bg-surface p-4 shadow-card">
          <PresetForm initial={presets.data} />
        </div>
      )}
    </SubScreen>
  );
}

export function AccountSettingsPage() {
  const { logout, logoutAll } = useAuth();
  const online = useOnline();
  const me = useQuery(meQuery());
  const [failed, setFailed] = useState(false);
  const run = (action: () => Promise<boolean>) => async () => {
    setFailed(false);
    if (!(await action())) setFailed(true);
  };
  return (
    <SubScreen title="アカウント" back="/settings">
      <Section title="表示名">
        <div className="rounded-l bg-surface p-4 shadow-card">
          {me.data && <DisplayNameForm key={me.data.displayName ?? ""} initial={me.data.displayName ?? ""} />}
        </div>
      </Section>
      <Section title="ログアウト">
        <div className="flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
          {failed && (
            <p role="status" className="text-ink-muted">
              ログアウトできませんでした。通信状態を確認して、もう一度お試しください。
            </p>
          )}
          <Button block disabled={!online} onClick={run(logout)}>
            ログアウト
          </Button>
          <Button block disabled={!online} onClick={run(logoutAll)}>
            すべての端末からログアウト
          </Button>
          {online ? (
            <Note>すべての端末からログアウトすると、有効な招待リンクも使えなくなります。</Note>
          ) : (
            <Note>オフラインの間はログアウトできません</Note>
          )}
        </div>
      </Section>
    </SubScreen>
  );
}
