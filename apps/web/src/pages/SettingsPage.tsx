import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { presetsQuery } from "../availability/queries";
import { useAuth } from "../auth/AuthProvider";
import { BottomSheet } from "../ui/BottomSheet";
import { connectionsQuery } from "../calendar/queries";
import { Avatar } from "../ui/Avatar";
import { Button } from "../ui/Button";
import { LoadError, Loading, Note } from "../ui/feedback";
import { Link } from "../ui/Link";
import { Section, SubScreen } from "../ui/Navigation";
import { useOnline } from "../ui/online";
import { PresetForm } from "../availability/PresetForm";
import { AvatarForm } from "../account/AvatarForm";
import { DisplayNameForm } from "../account/DisplayNameForm";
import { displayNameOf, meQuery } from "../account/me";
import { isContactOpenNow } from "../contact/open";

// 設定（docs/specs/T-11-design.md「画面のつながり」、キャンバス「19 設定」「21 時間帯プリセット」「23 アカウント」）
// 友達タブの「アカウント」の節から開く。初回設定・ログインの方法の連携は、それぞれのタスクで作る（#43・#45）。退会は T-16

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
        <Avatar name={me.data?.displayName ?? null} src={me.data?.avatarUrl ?? null} size="l" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-l font-bold">{me.data ? (me.data.displayName ?? "表示名は未設定です") : ""}</span>
          <Link to="/settings/account" className="text-s text-action underline">
            表示名・アイコンを変える
          </Link>
        </div>
      </div>
      <ul className="rounded-l bg-surface px-4 shadow-card">
        <Row to="/settings/calendar" label="カレンダー連携" value={status ? CALENDAR_STATUS[status] : undefined} />
        <Row to="/settings/presets" label="時間帯プリセット" value="昼・夕方・夜" />
        <Row to="/settings/notifications" label="通知の設定" />
        <Row to="/settings/account" label="アカウント" />
      </ul>
      <Section title="このアプリについて">
        <ul className="rounded-l bg-surface px-4 shadow-card">
          {/* 問い合わせ（T-24）は公開の日から出す */}
          {isContactOpenNow() && <Row to="/settings/contact" label="問い合わせ" />}
          <Row to="/settings/install" label="アプリとして使う" />
          <Row to="/privacy" label="プライバシー ポリシー" />
          <Row to="/terms" label="利用規約" />
        </ul>
      </Section>
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

/** ログインし直したあとに戻ってくる先（確認の画面をもう一度出す） */
/** 新しい端末のログインのお知らせから開いたことを表す `?from=` の値（notifications/text.ts の linkOf と揃える） */
export const NEW_LOGIN_FROM = "new_login";

export const WITHDRAW_RETURN_TO = "/settings/account?withdraw=1";

/** ログインの開始へ移る（テストで差し替える） */
export const reauthRedirect = { go: (url: string) => window.location.assign(url) };

/** 退会（docs/specs/T-16-withdrawal.md「画面」）。ほかの操作から離して置き、確認の画面を通す。赤を使わない */
function WithdrawSection({ reopen, name }: { reopen: boolean; name: string | null }) {
  const { withdraw } = useAuth();
  const online = useOnline();
  const [open, setOpen] = useState(reopen);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const submit = async () => {
    setSending(true);
    setFailed(false);
    const outcome = await withdraw();
    if (outcome.kind === "reauth") {
      // 直前のログインを、今と同じ方法で求める（別の方法は別の利用者になる）。戻ってきたら確認の画面をもう一度出す
      const returnTo = encodeURIComponent(WITHDRAW_RETURN_TO);
      reauthRedirect.go(outcome.provider ? `/api/v1/auth/${outcome.provider}/start?returnTo=${returnTo}` : `/login?returnTo=${returnTo}`);
      return;
    }
    if (outcome.kind === "failed") {
      setSending(false);
      setFailed(true);
    }
  };
  return (
    <Section title="退会">
      <div className="flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
        <Note>退会すると、ここ暇のデータが消えます。取り消せません。</Note>
        <Button block disabled={!online} onClick={() => setOpen(true)}>
          退会する
        </Button>
      </div>
      {open && (
        <BottomSheet title="退会しますか？" label="退会の確認" onClose={() => setOpen(false)}>
          <div className="flex flex-col gap-4">
            {name !== null && <p className="font-bold">{name}さんのアカウントを退会します。</p>}
            <p>退会すると、次のものが消えます。</p>
            <ul className="list-disc pl-6">
              <li>名前とアイコン</li>
              <li>ここ暇（空いている時間）</li>
              <li>友達</li>
              <li>カレンダーの連携</li>
              <li>お知らせ</li>
              <li>書いたひとこと・エリア・リンク</li>
              <li>行きたい</li>
            </ul>
            <p>友達の誘い・募集・予定の履歴には「退会したユーザー」と残ります。</p>
            <p>これからの成立した予定は「やっぱり難しい」になり、相手に知らせます。</p>
            <p>退会は取り消せません。退会の前に、もう一度ログインしてもらうことがあります。</p>
            {failed && (
              <p role="status" className="text-ink-muted">
                退会できませんでした。もう一度お試しください
              </p>
            )}
            <div className="flex flex-col gap-2">
              <Button block disabled={sending || !online} onClick={() => void submit()}>
                退会する
              </Button>
              <Button block variant="ghost" disabled={sending} onClick={() => setOpen(false)}>
                やめる
              </Button>
            </div>
          </div>
        </BottomSheet>
      )}
    </Section>
  );
}

export function AccountSettingsPage({ search = "" }: { search?: string }) {
  const { logout, logoutAll } = useAuth();
  const online = useOnline();
  const me = useQuery(meQuery());
  const [failed, setFailed] = useState(false);
  const run = (action: () => Promise<boolean>) => async () => {
    setFailed(false);
    if (!(await action())) setFailed(true);
  };
  // 新しい端末のログインのお知らせから開いたときだけ、理由と心当たりがないときの操作を出し、ログアウトの節へスクロールする
  // （docs/specs/T-11-design.md「画面のつながり」）。フォーカスは動かさない
  const fromNewLogin = new URLSearchParams(search).get("from") === NEW_LOGIN_FROM;
  const logoutSection = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!fromNewLogin) return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    logoutSection.current?.scrollIntoView?.({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [fromNewLogin]);
  return (
    <SubScreen title="アカウント" back="/settings">
      <Section title="表示名">
        <div className="rounded-l bg-surface p-4 shadow-card">
          {me.data && <DisplayNameForm initial={me.data.displayName ?? ""} />}
        </div>
      </Section>
      <Section title="アイコン">
        <div className="rounded-l bg-surface p-4 shadow-card">{me.data && <AvatarForm me={me.data} />}</div>
      </Section>
      <Section title="ログアウト" ref={logoutSection}>
        <div className="flex flex-col gap-2 rounded-l bg-surface p-4 shadow-card">
          {fromNewLogin && (
            <Note>新しい端末でのログインのお知らせから開きました。心当たりがなければ、「すべての端末からログアウト」を押してください。</Note>
          )}
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
      <WithdrawSection
        reopen={new URLSearchParams(search).get("withdraw") === "1"}
        name={me.data ? displayNameOf(me.data.displayName) : null}
      />
    </SubScreen>
  );
}
