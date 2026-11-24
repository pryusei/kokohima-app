import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type MouseEvent, type ReactNode, type Ref } from "react";
import { unreadCountQuery } from "../notifications/queries";
import { goBack, useLocation } from "../router";
import { Loading, OfflineBanner } from "./feedback";
import { Link } from "./Link";
import { MOTION_MS, prefersReducedMotion, useExitAnimation } from "./motion";
import { useDesktop } from "./useDesktop";

// 画面の枠（docs/specs/T-11-design.md「画面のつながり」、デザインシステム「TabBar」「Header」）
// 下のタブは4つ。お知らせはタブにせず、ヘッダーの鐘から開く
// PC（幅1024px以上）では左のナビにし、お知らせと設定もナビに置く（docs/specs/T-20-desktop-layout.md）

const Icon = ({ children }: { children: ReactNode }) => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

/** 今いるタブの、塗りの版のアイコン（docs/specs/T-56-motion.md「M-07」）。中の線は地の色で抜く */
const FilledIcon = ({ children }: { children: ReactNode }) => (
  <svg
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="currentColor"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    data-filled=""
  >
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
    filled: (
      <FilledIcon>
        <circle cx="9" cy="9" r="3.2" />
        <circle cx="16.5" cy="10" r="2.6" />
        <path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5z" />
        <path d="M14.5 15.2c2.6-.5 4.8.8 5.8 3.8h-5.3z" />
      </FilledIcon>
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
    filled: (
      <FilledIcon>
        <rect x="5" y="4" width="14" height="16" rx="3" />
        <path className="stroke-surface" d="M9 9h6M9 13h6" />
      </FilledIcon>
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
    filled: (
      <FilledIcon>
        <path d="M4 6h16v12H4z" />
        <path className="stroke-surface" fill="none" d="m4 7 8 6 8-6" />
      </FilledIcon>
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
    filled: (
      <FilledIcon>
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 20c1-3.6 3.8-5.5 7-5.5s6 1.9 7 5.5z" />
      </FilledIcon>
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
  "group flex flex-col items-center gap-0.5 py-1 text-xs font-bold no-underline lg:min-h-11 lg:flex-row lg:gap-3 lg:rounded-m lg:px-3 lg:py-2 lg:text-m";

// 押したらアイコンが縮み（press）、離すとばねで戻る（base・spring）
const NAV_ICON =
  "grid transition-transform duration-(--duration-base) ease-spring group-active:scale-[.88] group-active:duration-(--duration-press) group-active:ease-out";

/**
 * 1つのリンク（docs/specs/T-56-motion.md「M-07」）。今いる場所は、塗りのアイコンと、アイコンの下の短い線（ink）。
 * PC の左のナビは bg-head。黄色（lamp）はタブに使わない。
 * onCurrent があると、今いる場所をもう一度押したときに移らず、それを呼ぶ（タブは一番上へ戻る）
 */
function NavLink({
  to,
  current,
  icon,
  filled,
  label,
  onCurrent,
  children,
}: {
  to: string;
  current: boolean;
  icon: ReactNode;
  filled?: ReactNode;
  label: string;
  onCurrent?: () => void;
  children?: ReactNode;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!current || !onCurrent || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onCurrent();
  };
  return (
    <Link
      to={to}
      current={current}
      aria-label={label}
      onClick={onClick}
      className={`${NAV_LINK} ${current ? "text-ink lg:bg-head" : "text-ink-muted lg:hover:bg-surface-sunken"}`}
    >
      <span className={NAV_ICON}>{current && filled ? filled : icon}</span>
      <span aria-hidden="true" className="lg:flex-1">
        {children ?? label}
      </span>
      <span
        aria-hidden="true"
        data-testid={current ? "nav-current-line" : undefined}
        className={`h-0.5 w-4 rounded-full lg:hidden ${current ? "bg-ink" : "bg-transparent"}`}
      />
    </Link>
  );
}

/** 今いるタブをもう一度押したとき：一番上までスクロールする（URL は変えない。動きを止める設定では即時） */
function scrollToTop() {
  window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
}

/** 未読の数。読めなくても0として扱う（読み込み中は undefined。読み終わった最初の数では「ぽん」しない） */
function useUnread() {
  const count = useQuery(unreadCountQuery()).data?.count;
  return { count, label: unreadLabel(count ?? 0).label };
}

/**
 * 未読のバッジ（docs/specs/T-56-motion.md「M-15」）。出るとき・数が増えたときに「ぽん」（最初の描画・減ったときは動かさない）。
 * 0 になったら、縮んで薄くなってから消える
 */
export function UnreadBadge({ count }: { count: number | undefined }) {
  const badge = unreadLabel(count ?? 0).badge;
  const [prev, setPrev] = useState(count);
  // 「ぽん」の回数。変わるたびに要素を作り直して、もう一度動かす
  const [pops, setPops] = useState(0);
  // 消える動きのあいだも、前の数を出す
  const [shown, setShown] = useState(badge);
  if (count !== prev) {
    setPrev(count);
    if (count !== undefined && prev !== undefined && count > prev) setPops((n) => n + 1);
  }
  if (badge && badge !== shown) setShown(badge);
  const { exiting, start, cancel, ref } = useExitAnimation<HTMLSpanElement>(MOTION_MS.fast);
  useEffect(() => {
    if (badge) cancel();
    else if (shown) start(() => setShown(null));
  }, [badge, shown, start, cancel]);
  if (!shown) return null;
  return (
    <span
      key={pops}
      ref={ref}
      aria-hidden="true"
      data-testid="unread-badge"
      data-pop={pops > 0 ? "" : undefined}
      data-exiting={exiting ? "" : undefined}
      className="kh-badge inline-block min-w-[18px] rounded-full bg-lamp px-1.5 text-center text-xs leading-[18px] font-bold text-on-lamp tabular-nums"
    >
      {shown}
    </span>
  );
}

/** PC の配置でだけ出す、左のナビのお知らせと設定（スマホではヘッダーの鐘と、友達タブの「アカウント」から開く） */
function DesktopExtras({ pathname, count, label }: { pathname: string; count: number | undefined; label: string }) {
  return (
    <>
      <hr aria-hidden="true" className="my-2 border-line" />
      <NavLink to="/notifications" current={pathname === "/notifications"} icon={BELL} label={label}>
        <span className="flex items-center justify-between gap-2">
          お知らせ
          <UnreadBadge count={count} />
        </span>
      </NavLink>
      <NavLink to="/settings" current={pathname === "/settings" || pathname.startsWith("/settings/")} icon={GEAR} label="設定" />
    </>
  );
}

function DesktopExtrasWithUnread({ pathname }: { pathname: string }) {
  const { count, label } = useUnread();
  return <DesktopExtras pathname={pathname} count={count} label={label} />;
}

/**
 * 下のタブ（スマホ）と左のナビ（PC）。1つの nav の見た目を幅で変える。
 * 画面の切り替え（View Transitions）では動かさない（view-transition-name。docs/specs/T-56-motion.md「M-13」）
 */
function NavFrame({ pathname, inert, extras }: { pathname: string; inert?: boolean; extras: ReactNode }) {
  const desktop = useDesktop();
  return (
    <nav
      aria-label="タブ"
      inert={inert || undefined}
      className="fixed inset-x-0 bottom-0 z-10 mx-auto grid max-w-md grid-cols-4 border-t border-line bg-surface pt-1 pb-[max(8px,env(safe-area-inset-bottom))] [view-transition-name:kh-tabbar] lg:top-0 lg:right-auto lg:mx-0 lg:flex lg:w-60 lg:max-w-none lg:flex-col lg:gap-1 lg:overflow-y-auto lg:border-t-0 lg:border-r lg:px-3 lg:py-4 lg:[view-transition-name:kh-sidenav]"
    >
      {desktop && (
        <span aria-hidden="true" className="px-3 pb-3 text-l font-bold text-ink">
          ここ暇
        </span>
      )}
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} current={pathname === t.to} icon={t.icon} filled={t.filled} label={t.label} onCurrent={scrollToTop} />
      ))}
      {desktop && extras}
    </nav>
  );
}

/**
 * 下のタブ（スマホ）と左のナビ（PC。docs/specs/T-20-desktop-layout.md「画面の枠」）
 */
export function TabBar() {
  const { pathname } = useLocation();
  return <NavFrame pathname={pathname} extras={<DesktopExtrasWithUnread pathname={pathname} />} />;
}

/** 鐘のボタンの読み上げ。API の未読の数は99で頭打ち（UNREAD_CAP）なので、99は「99件以上」 */
export function unreadLabel(count: number) {
  if (count <= 0) return { badge: null, label: "お知らせ" };
  if (count >= 99) return { badge: "99+", label: "お知らせ 99件以上の未読" };
  return { badge: String(count), label: `お知らせ ${count}件の未読` };
}

function Bell() {
  // 未読の数。読めなくてもボタンは出す
  const { count, label } = useUnread();
  return (
    <Link to="/notifications" aria-label={label} className="relative grid size-11 place-items-center rounded-full text-ink">
      {BELL}
      <span className="absolute top-1 right-0">
        <UnreadBadge count={count} />
      </span>
    </Link>
  );
}

/** ログインの確認中の鐘：同じ大きさの、押せない印（未読の数は読みに行かない。docs/specs/T-56-motion.md「M-05」） */
function BellMark() {
  return (
    <span aria-hidden="true" className="relative grid size-11 place-items-center rounded-full text-ink">
      {BELL}
    </span>
  );
}

// 画面の枠。PC では左のナビの右に、最大768pxで左寄せにする
const FRAME = "mx-auto flex min-h-dvh max-w-md flex-col lg:mx-0 lg:max-w-3xl";

/**
 * タブの画面の置き方（ヘッダー・オフラインの帯・中身・下のタブ）。TabScreen と、ログインの確認中の殻（TabShell）が同じ置き方で描く
 * （確認中と確認後で、ヘッダーと下のタブの位置が動かない。docs/specs/T-56-motion.md「M-05」）
 */
function TabLayout({ title, nav, bell, children }: { title: string; nav: ReactNode; bell: ReactNode; children: ReactNode }) {
  const desktop = useDesktop();
  return (
    <div className="lg:pl-60">
      {/* PC では左のナビを中身の前に置き、Tab でナビに先に着くようにする。スマホは今のまま中身のあと。
          どちらも同じ並びの位置に描くので、幅が変わっても中身は作り直さない */}
      {desktop && nav}
      <div className={FRAME}>
        {/* 高さ68px＝鐘（44px）＋上下の余白。PC で鐘を出さなくても、ヘッダーの高さを変えない */}
        <header className="flex min-h-[68px] items-center justify-between px-4 py-3 lg:px-6">
          <h1 className="text-xl font-bold">{title}</h1>
          {!desktop && bell}
        </header>
        {/* 画面の切り替え（M-07・M-13）で動かすのは、この中身の領域だけ */}
        <main className="flex flex-1 flex-col gap-4 px-4 pb-28 [view-transition-name:kh-content] lg:px-6 lg:pb-10">
          <OfflineBanner />
          {children}
        </main>
      </div>
      {!desktop && nav}
    </div>
  );
}

/** タブの画面：ヘッダー（名前と鐘）・オフラインの帯・中身・下のタブ（PC では左のナビ。鐘はナビのお知らせに移す） */
export function TabScreen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <TabLayout title={title} nav={<TabBar />} bell={<Bell />}>
      {children}
    </TabLayout>
  );
}

/** ログインの確認中の殻に出す骨組みの形（docs/specs/T-56-motion.md「M-06」） */
const SHELL_SKELETON: Record<TabPath, "card" | "list" | "chips"> = { "/": "chips", "/availability": "chips", "/invites": "card", "/friends": "list" };

/**
 * ログインの確認中の殻（docs/specs/T-56-motion.md「M-05」）：タブの名前のヘッダーと、押せない（inert）下のタブ・左のナビと、骨組み。
 * 未読の数・個人の情報は読まない・出さない
 */
export function TabShell({ tab }: { tab: TabPath }) {
  const title = TABS.find((t) => t.to === tab)?.label ?? "";
  return (
    <TabLayout
      title={title}
      nav={<NavFrame pathname={tab} inert extras={<DesktopExtras pathname={tab} count={0} label="お知らせ" />} />}
      bell={<BellMark />}
    >
      <Loading variant={SHELL_SKELETON[tab]} />
    </TabLayout>
  );
}

/** 設定・お知らせの画面：左上の「戻る」と名前。下のタブは出さない（PC では左のナビを出す） */
function SubFrame({ title, back, nav, children }: { title: string; back: string; nav: ReactNode; children: ReactNode }) {
  return (
    <div className={nav ? "lg:pl-60" : undefined}>
      {/* PC では左のナビを中身の前に置く（TabScreen と同じ） */}
      {nav}
      <div className={FRAME}>
        <header className="flex items-center gap-1 px-2 py-3 lg:px-4">
          <button type="button" aria-label="戻る" className="grid size-11 place-items-center rounded-full text-ink" onClick={() => goBack(back)}>
            <Icon>
              <path d="m15 6-6 6 6 6" />
            </Icon>
          </button>
          <h1 className="text-xl font-bold">{title}</h1>
        </header>
        <main className="flex flex-1 flex-col gap-4 px-4 pb-10 [view-transition-name:kh-content] lg:px-6">
          <OfflineBanner />
          {children}
        </main>
      </div>
    </div>
  );
}

export function SubScreen({ title, back, children }: { title: string; back: string; children: ReactNode }) {
  const desktop = useDesktop();
  return (
    <SubFrame title={title} back={back} nav={desktop && <TabBar />}>
      {children}
    </SubFrame>
  );
}

/**
 * ログインしなくても開く画面（プライバシー ポリシー・利用規約）：戻るつきで、PC でも左のナビを出さない
 * （docs/specs/T-20-desktop-layout.md「画面の枠」。ナビの未読の数を、ログインしていない人のために読みに行かない）
 */
export function PublicSubScreen({ title, back, children }: { title: string; back: string; children: ReactNode }) {
  return (
    <SubFrame title={title} back={back} nav={null}>
      {children}
    </SubFrame>
  );
}

/** 一覧の節の見出し */
export function Section({
  title,
  aside,
  children,
  ref,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
}) {
  return (
    <section ref={ref} className="flex flex-col gap-2">
      <h2 className="flex items-baseline justify-between gap-2 text-l font-bold">
        {title}
        {aside && <span className="text-s font-normal text-ink-muted">{aside}</span>}
      </h2>
      {children}
    </section>
  );
}
