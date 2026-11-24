import { Suspense, useEffect, type ReactNode } from "react";
import { NameGate } from "./account/NameGate";
import { useAuth } from "./auth/AuthProvider";
import { AuthCompletePage } from "./pages/AuthCompletePage";
import { AvailabilityPage } from "./pages/AvailabilityPage";
import { CalendarSettingsPage } from "./pages/CalendarSettingsPage";
import { ContactPage } from "./pages/ContactPage";
import { isContactOpenNow } from "./contact/open";
import { BlockedUsersPage } from "./pages/BlockedUsersPage";
import { isSafetyOpenNow } from "./safety/open";
import { EveryonePage } from "./pages/EveryonePage";
import { InstallPage } from "./pages/InstallPage";
import { FriendDetailPage } from "./pages/FriendDetailPage";
import { BroadcastDetailPage } from "./pages/BroadcastDetailPage";
import { BroadcastNewPage } from "./pages/BroadcastNewPage";
import { FriendsPage } from "./pages/FriendsPage";
import { InviteDetailPage } from "./pages/InviteDetailPage";
import { InviteNewPage } from "./pages/InviteNewPage";
import { InvitesPage } from "./pages/InvitesPage";
import { NotificationSettingsPage } from "./pages/NotificationSettingsPage";
import { NotificationsPage } from "./pages/NotificationsPage";
import { MeetupDetailPage } from "./pages/MeetupDetailPage";
import { InvitePage } from "./pages/InvitePage";
import { LoginPage } from "./pages/LoginPage";
import { WelcomePage } from "./pages/WelcomePage";
import { AccountSettingsPage, PresetSettingsPage, SettingsPage } from "./pages/SettingsPage";
import { behindTab, navigate, useLocation, useNavigationScroll } from "./router";
import { Button } from "./ui/Button";
import { Loading } from "./ui/feedback";
import { TabShell, type TabPath } from "./ui/Navigation";
import { lazyPage } from "./ui/lazyPage";
import { ResultBandProvider } from "./ui/ResultBand";

// プライバシー ポリシーと利用規約は本文が長く、開く人が少ないので、別のチャンクにする（docs/specs/T-49-perf-small-fixes.md「4.」）
const PrivacyPage = lazyPage(() => import("./pages/PrivacyPage"), (m) => m.PrivacyPage);
const TermsPage = lazyPage(() => import("./pages/TermsPage"), (m) => m.TermsPage);

/** 遅延読み込みのページを読んでいる間（ログインの確認中と同じ形） */
function PageLoading() {
  return (
    <main className="mx-auto max-w-md p-6">
      <Loading />
    </main>
  );
}

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

const TAB_PAGES: Record<TabPath, (search: string) => ReactNode> = {
  "/": () => <EveryonePage />,
  "/availability": () => <AvailabilityPage />,
  "/invites": (search) => <InvitesPage search={search} />,
  "/friends": () => <FriendsPage />,
};

const isTab = (path: string): path is TabPath => path in TAB_PAGES;

/** URL を持つシートと、その後ろに出すタブ（docs/specs/T-11-design.md「画面のつながり」の表） */
function sheetOf(pathname: string, search: string): { tab: TabPath; sheet: ReactNode } | null {
  if (pathname === "/invites/new") return { tab: "/", sheet: <InviteNewPage key={search} /> };
  if (pathname === "/broadcasts/new") return { tab: "/", sheet: <BroadcastNewPage key={search} /> };
  const id = (re: RegExp) => {
    const m = re.exec(pathname)?.[1];
    return m ? decodeURIComponent(m) : null;
  };
  const broadcast = id(/^\/broadcasts\/([^/]+)$/);
  if (broadcast) return { tab: "/invites", sheet: <BroadcastDetailPage key={broadcast} broadcastId={broadcast} /> };
  const invite = id(/^\/invites\/([^/]+)$/);
  if (invite) return { tab: "/invites", sheet: <InviteDetailPage key={invite} inviteId={invite} /> };
  const meetup = id(/^\/meetups\/([^/]+)$/);
  if (meetup) return { tab: "/invites", sheet: <MeetupDetailPage key={meetup} meetupId={meetup} /> };
  const friend = id(/^\/friends\/([^/]+)$/);
  if (friend) return { tab: "/friends", sheet: <FriendDetailPage key={friend} friendId={friend} /> };
  return null;
}

/**
 * タブの画面。シートを開いている間は、後ろのタブを inert にする（シートは body の直下に描く）。
 * タブの画面は同じ位置に描くので、シートを閉じても状態とフォーカスを戻す先（開いたボタン）が残る
 */
function TabHost({ tab, search, sheet }: { tab: TabPath; search: string; sheet: ReactNode | null }) {
  return (
    <>
      <div inert={sheet ? true : undefined} aria-hidden={sheet ? true : undefined}>
        {TAB_PAGES[tab](search)}
      </div>
      {sheet}
    </>
  );
}

/** シートの後ろに出すタブ。アプリの中から開いたら、開いたときのタブ（?tab= も）のまま。外から直接開いたら表のタブ */
function behindOf(fallback: TabPath) {
  const behind = behindTab();
  if (!behind) return { tab: fallback, search: "" };
  const url = new URL(behind, window.location.origin);
  return isTab(url.pathname) ? { tab: url.pathname, search: url.search } : { tab: fallback, search: "" };
}

/** ログインの確認中（と表示名の確認中）に出すタブの殻。タブと、後ろにタブを出すシートの URL だけ（docs/specs/T-56-motion.md「M-05」） */
function shellOf(pathname: string, search: string): ReactNode | null {
  const sheet = sheetOf(pathname, search);
  if (sheet) return <TabShell tab={behindOf(sheet.tab).tab} />;
  if (isTab(pathname)) return <TabShell tab={pathname} />;
  return null;
}

/** 操作の結果の帯は、アプリに1つだけ置く（docs/specs/T-56-motion.md「M-09」） */
export function App() {
  return (
    <ResultBandProvider>
      <Routes />
    </ResultBandProvider>
  );
}

function Routes() {
  const { pathname, search } = useLocation();
  const { status, retry } = useAuth();
  useNavigationScroll();

  if (pathname === "/auth/complete") return <AuthCompletePage />;
  // 招待リンクの受け口は未ログインでも描画する（振り分けると、フラグメントのトークンを失う）
  if (pathname === "/invite") return <InvitePage />;
  // プライバシー ポリシーと利用規約は、ログインの状態によらず出す（docs/specs/T-19-privacy-terms.md「1.」）
  if (pathname === "/privacy" || pathname === "/terms") {
    return <Suspense fallback={<PageLoading />}>{pathname === "/privacy" ? <PrivacyPage /> : <TermsPage />}</Suspense>;
  }

  // タブと、後ろにタブを出すシートの URL では、確認中もそのタブの殻を出す（シートは確認のあとに描く。docs/specs/T-56-motion.md「M-05」）
  const shell = shellOf(pathname, search);
  if (status === "checking") return shell ?? <PageLoading />;

  if (status === "error") {
    return (
      <main className="mx-auto flex max-w-md flex-col gap-4 p-6">
        <p role="status">接続できませんでした。通信状態を確認して、もう一度お試しください。</p>
        <Button onClick={retry}>もう一度試す</Button>
      </main>
    );
  }

  if (pathname === "/login") {
    if (status === "authenticated") return <Redirect to="/" />;
    return <LoginPage search={search} />;
  }

  if (status === "anonymous") {
    const returnTo = pathname + search;
    return <Redirect to={returnTo === "/" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }

  // 表示名が空のあいだは、どの画面の代わりにも名前の画面を出す（docs/specs/T-31-display-name-first-step.md）
  return (
    <NameGate fallback={shell}>
      <SignedIn pathname={pathname} search={search} />
    </NameGate>
  );
}

/** ログイン済みで、表示名がある人の画面 */
function SignedIn({ pathname, search }: { pathname: string; search: string }) {
  if (pathname === "/welcome") return <WelcomePage />;
  if (pathname === "/notifications") return <NotificationsPage />;
  if (pathname === "/settings") return <SettingsPage />;
  if (pathname === "/settings/calendar") return <CalendarSettingsPage search={search} />;
  if (pathname === "/settings/presets") return <PresetSettingsPage />;
  if (pathname === "/settings/notifications") return <NotificationSettingsPage />;
  if (pathname === "/settings/install") return <InstallPage />;
  if (pathname === "/settings/account") return <AccountSettingsPage search={search} />;
  // 問い合わせ（T-24）。公開の日より前は、知らない経路と同じ扱い（みんなのタブ）
  if (pathname === "/settings/contact" && isContactOpenNow()) return <ContactPage />;
  // ブロックした人（T-33）。始める日より前は、知らない経路と同じ扱い
  if (pathname === "/settings/blocks" && isSafetyOpenNow()) return <BlockedUsersPage />;

  const sheet = sheetOf(pathname, search);
  if (sheet) {
    const behind = behindOf(sheet.tab);
    return <TabHost tab={behind.tab} search={behind.search} sheet={sheet.sheet} />;
  }
  return <TabHost tab={isTab(pathname) ? pathname : "/"} search={search} sheet={null} />;
}
