import { useEffect, type ReactNode } from "react";
import { useAuth } from "./auth/AuthProvider";
import { AuthCompletePage } from "./pages/AuthCompletePage";
import { AvailabilityPage } from "./pages/AvailabilityPage";
import { CalendarSettingsPage } from "./pages/CalendarSettingsPage";
import { EveryonePage } from "./pages/EveryonePage";
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
import { AccountSettingsPage, PresetSettingsPage, SettingsPage } from "./pages/SettingsPage";
import { navigate, useLocation } from "./router";
import { Button } from "./ui/Button";
import { Loading } from "./ui/feedback";
import type { TabPath } from "./ui/Navigation";

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

const TAB_PAGES: Record<TabPath, () => ReactNode> = {
  "/": () => <EveryonePage />,
  "/availability": () => <AvailabilityPage />,
  "/invites": () => <InvitesPage />,
  "/friends": () => <FriendsPage />,
};

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
 * タブの画面。シートを開いている間は、後ろのタブを inert にする。
 * タブの画面は同じ位置に描くので、シートを閉じても状態とフォーカスを戻す先（開いたボタン）が残る
 */
function TabHost({ tab, sheet }: { tab: TabPath; sheet: ReactNode | null }) {
  return (
    <>
      <div inert={sheet ? true : undefined} aria-hidden={sheet ? true : undefined}>
        {TAB_PAGES[tab]()}
      </div>
      {sheet}
    </>
  );
}

export function App() {
  const { pathname, search } = useLocation();
  const { status, retry } = useAuth();

  if (pathname === "/auth/complete") return <AuthCompletePage />;
  // 招待リンクの受け口は未ログインでも描画する（振り分けると、フラグメントのトークンを失う）
  if (pathname === "/invite") return <InvitePage />;

  if (status === "checking") {
    return (
      <main className="mx-auto max-w-md p-6">
        <Loading />
      </main>
    );
  }

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

  if (pathname === "/notifications") return <NotificationsPage />;
  if (pathname === "/settings") return <SettingsPage />;
  if (pathname === "/settings/calendar") return <CalendarSettingsPage search={search} />;
  if (pathname === "/settings/presets") return <PresetSettingsPage />;
  if (pathname === "/settings/notifications") return <NotificationSettingsPage />;
  if (pathname === "/settings/account") return <AccountSettingsPage />;

  const sheet = sheetOf(pathname, search);
  if (sheet) return <TabHost tab={sheet.tab} sheet={sheet.sheet} />;
  const tab = (Object.keys(TAB_PAGES) as TabPath[]).find((t) => t === pathname) ?? "/";
  return <TabHost tab={tab} sheet={null} />;
}
