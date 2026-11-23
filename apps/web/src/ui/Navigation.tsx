import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { unreadCountQuery } from "../notifications/queries";
import { goBack, useLocation } from "../router";
import { OfflineBanner } from "./feedback";
import { Link } from "./Link";
import { useDesktop } from "./useDesktop";

// 画面の枠（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「TabBar」「Header」）
// 下のタブは4つ。お知らせはタブにせず、ヘッダーの鐘から開く
// PC（幅1024px以上）では左のナビにし、お知らせと設定もナビに置く（docs/specs/T-20-desktop-layout.md）

const Icon = ({ children }: { children: ReactNode }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const TABS = [
  {
    to: "/",
    label: "みんな",
    icon: (
      <Icon>
        <circle cx="9" cy="9" r="3.2" />
        <circle cx="16.5" cy="10" r="2.6" />
        <path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M14.5 15.2c2.6-.5 4.8.8 5.8 3.8" />
      </Icon>
    ),
  },
  {
    to: "/availability",
    label: "ここ暇",
    icon: (
      <Icon>
        <rect x="5" y="4" width="14" height="16" rx="3" />
        <path d="M9 9h6M9 13h6" />
      </Icon>
    ),
  },
  {
    to: "/invites",
    label: "誘い",
    icon: (
      <Icon>
        <path d="M4 6h16v12H4z" />
        <path d="m4 7 8 6 8-6" />
      </Icon>
    ),
  },
  {
    to: "/friends",
    label: "友達",
    icon: (
      <Icon>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5" />
      </Icon>
    ),
  },
] as const;

export type TabPath = (typeof TABS)[number]["to"];

const GEAR = (
  <Icon>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
  </Icon>
);

const BELL = (
  <Icon>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Icon>
);

// 下のタブ（スマホ）と左のナビ（PC）の、1つのリンクの見た目
const NAV_LINK =
  "flex flex-col items-center gap-0.5 py-1 text-xs font-bold no-underline lg:min-h-11 lg:flex-row lg:gap-3 lg:rounded-m lg:px-3 lg:py-2 lg:text-m";

function NavLink({ to, current, icon, label, children }: { to: string; current: boolean; icon: ReactNode; label: string; children?: ReactNode }) {
  return (
    <Link
      to={to}
      current={current}
      aria-label={label}
      className={`${NAV_LINK} ${current ? "text-ink lg:bg-lamp-soft" : "text-ink-muted lg:hover:bg-surface-sunken"}`}
    >
      {icon}
      <span aria-hidden="true" className="lg:flex-1">
        {children ?? label}
      </span>
      <span aria-hidden="true" className={`size-1 rounded-full lg:hidden ${current ? "bg-lamp-line" : "bg-transparent"}`} />
    </Link>
  );
}

/** 未読の数。読めなくても0として扱う */
function useUnread() {
  const count = useQuery(unreadCountQuery()).data?.count ?? 0;
  return unreadLabel(count);
}

function UnreadBadge({ badge }: { badge: string }) {
  return (
    <span aria-hidden="true" className="min-w-[18px] rounded-full bg-lamp px-1.5 text-center text-xs leading-[18px] font-bold text-on-lamp tabular-nums">
      {badge}
    </span>
  );
}

/** PC の配置でだけ出す、左のナビのお知らせと設定（スマホではヘッダーの鐘と、友達タブの「アカウント」から開く） */
function DesktopExtras({ pathname }: { pathname: string }) {
  const { badge, label } = useUnread();
  return (
    <>
      <hr aria-hidden="true" className="my-2 border-line" />
      <NavLink to="/notifications" current={pathname === "/notifications"} icon={BELL} label={label}>
        <span className="flex items-center justify-between gap-2">
          お知らせ
          {badge && <UnreadBadge badge={badge} />}
        </span>
      </NavLink>
      <NavLink to="/settings" current={pathname === "/settings" || pathname.startsWith("/settings/")} icon={GEAR} label="設定" />
    </>
  );
}

/**
 * 下のタブ（スマホ）と左のナビ（PC。docs/specs/T-20-desktop-layout.md「画面の枠」）。1つの nav の見た目を幅で変える
 */
export function TabBar() {
  const { pathname } = useLocation();
  const desktop = useDesktop();
  return (
    <nav
      aria-label="タブ"
      className="fixed inset-x-0 bottom-0 z-10 mx-auto grid max-w-md grid-cols-4 border-t border-line bg-surface pt-1 pb-[max(8px,env(safe-area-inset-bottom))] lg:top-0 lg:right-auto lg:mx-0 lg:flex lg:w-60 lg:max-w-none lg:flex-col lg:gap-1 lg:overflow-y-auto lg:border-t-0 lg:border-r lg:px-3 lg:py-4"
    >
      {desktop && (
        <span aria-hidden="true" className="px-3 pb-3 text-l font-bold text-ink">
          ここ暇
        </span>
      )}
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} current={pathname === t.to} icon={t.icon} label={t.label} />
      ))}
      {desktop && <DesktopExtras pathname={pathname} />}
    </nav>
  );
}

/** 鐘のボタンの読み上げ。API の未読の数は99で頭打ち（UNREAD_CAP）なので、99は「99件以上」 */
export function unreadLabel(count: number) {
  if (count <= 0) return { badge: null, label: "お知らせ" };
  if (count >= 99) return { badge: "99+", label: "お知らせ 99件以上の未読" };
  return { badge: String(count), label: `お知らせ ${count}件の未読` };
}

function Bell() {
  // 未読の数。読めなくてもボタンは出す
  const { badge, label } = useUnread();
  return (
    <Link to="/notifications" aria-label={label} className="relative grid size-11 place-items-center rounded-full text-ink">
      {BELL}
      {badge && (
        <span className="absolute top-1 right-0">
          <UnreadBadge badge={badge} />
        </span>
      )}
    </Link>
  );
}

// 画面の枠。PC では左のナビの右に、最大768pxで左寄せにする
const FRAME = "mx-auto flex min-h-dvh max-w-md flex-col lg:mx-0 lg:max-w-3xl";

/** タブの画面：ヘッダー（名前と鐘）・オフラインの帯・中身・下のタブ（PC では左のナビ。鐘はナビのお知らせに移す） */
export function TabScreen({ title, children }: { title: string; children: ReactNode }) {
  const desktop = useDesktop();
  return (
    <div className="lg:pl-60">
      {/* PC では左のナビを中身の前に置き、Tab でナビに先に着くようにする。スマホは今のまま中身のあと。
          どちらも同じ並びの位置に描くので、幅が変わっても中身は作り直さない */}
      {desktop && <TabBar />}
      <div className={FRAME}>
        {/* 高さ68px＝鐘（44px）＋上下の余白。PC で鐘を出さなくても、ヘッダーの高さを変えない */}
        <header className="flex min-h-[68px] items-center justify-between px-4 py-3 lg:px-6">
          <h1 className="text-xl font-bold">{title}</h1>
          {!desktop && <Bell />}
        </header>
        <main className="flex flex-1 flex-col gap-4 px-4 pb-28 lg:px-6 lg:pb-10">
          <OfflineBanner />
          {children}
        </main>
      </div>
      {!desktop && <TabBar />}
    </div>
  );
}

/** 設定・お知らせの画面：左上の「戻る」と名前。下のタブは出さない（PC では左のナビを出す） */
export function SubScreen({ title, back, children }: { title: string; back: string; children: ReactNode }) {
  const desktop = useDesktop();
  return (
    <div className="lg:pl-60">
      {/* PC では左のナビを中身の前に置く（TabScreen と同じ） */}
      {desktop && <TabBar />}
      <div className={FRAME}>
        <header className="flex items-center gap-1 px-2 py-3 lg:px-4">
          <button type="button" aria-label="戻る" className="grid size-11 place-items-center rounded-full text-ink" onClick={() => goBack(back)}>
            <Icon>
              <path d="m15 6-6 6 6 6" />
            </Icon>
          </button>
          <h1 className="text-xl font-bold">{title}</h1>
        </header>
        <main className="flex flex-1 flex-col gap-4 px-4 pb-10 lg:px-6">
          <OfflineBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

/** 一覧の節の見出し */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-baseline justify-between gap-2 text-l font-bold">
        {title}
        {aside && <span className="text-s font-normal text-ink-muted">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}
