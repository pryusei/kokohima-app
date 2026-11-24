import { useLayoutEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { prefersReducedMotion } from "./ui/motion";
import { rememberTabScroll, scrollTargetOnPop, tabScrollTarget, type ScrollPositions } from "./ui/tabScroll";

// 画面が少ないうちは最小のルーター。URLが変わったら popstate で知らせる。
// 画面の切り替えの動き（View Transitions）とスクロールの位置もここで扱う（docs/specs/T-56-motion.md「M-07」「M-13」）

/** 下のタブの URL（docs/specs/T-11-design.md「画面のつながり」） */
export const TAB_PATHS = ["/", "/availability", "/invites", "/friends"] as const;

const isTabPath = (path: string) => (TAB_PATHS as readonly string[]).includes(path);

/** URL を持つシート（App.tsx の sheetOf の表と同じ。docs/specs/T-11-design.md「画面のつながり」） */
export function isSheetPath(pathname: string): boolean {
  return pathname === "/invites/new" || pathname === "/broadcasts/new" || /^\/(?:broadcasts|invites|meetups|friends)\/[^/]+$/.test(pathname);
}

/**
 * アプリの中の遷移で積む履歴の印。behind は、シートを開いたときに後ろに出していたタブの URL（?tab= も含む）。
 * タブからシートを開いたらそのタブ、シートからシートを開いたら前のシートの behind を引き継ぐ。
 * depth は積んだ深さ（外から直接開いたときは0。戻る・進むの向き。M-13）、key はエントリの印（中身のない無作為の文字列。スクロールの位置。M-07）
 */
type HistoryState = { inApp: true; behind: string | null; depth: number; key: string };

const state = () => window.history.state as Partial<HistoryState> | null;

const newKey = () => Math.random().toString(36).slice(2, 10);

/** 今のエントリ（パス・深さ・印） */
type Entry = { path: string; depth: number; key: string | null };
const entryNow = (): Entry => ({
  path: window.location.pathname,
  depth: state()?.depth ?? 0,
  key: state()?.key ?? null,
});

// スクロールの位置（M-07）。メモリだけに持つ。ブラウザの復元は止め、自分で戻す
let tabPositions: ScrollPositions = new Map();
let entryPositions: ScrollPositions = new Map();
if (typeof window !== "undefined" && "scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

/** 画面を離れるときに、そのエントリ（とタブ）の位置を覚える */
function remember(from: Entry) {
  const y = window.scrollY;
  if (from.key !== null) entryPositions = new Map(entryPositions).set(from.key, y);
  if (isTabPath(from.path)) tabPositions = rememberTabScroll(tabPositions, from.path, y);
}

/** 描いたあとに戻すスクロールの位置（null なら動かさない） */
let pendingScroll: number | null = null;
/** navigate が出す合成の popstate か（向きは進む。位置は navigate の中で覚えた） */
let navigating = false;
/** 今描いているエントリ */
let shown: Entry | null = null;

const listeners = new Set<() => void>();
function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}
const notify = () => {
  for (const l of listeners) l();
};
// 今の URL をそのまま返す（View Transitions の更新を待つあいだも前の URL で描き止めない。止めると、そのあいだに
// ログインの状態などが変わったときに、前の URL のまま振り分けてしまう）
const snapshot = () => window.location.pathname + window.location.search;

export type TransitionKind = "none" | "fade" | "push" | "pop";

/**
 * 画面の切り替えの動きの種類（docs/specs/T-56-motion.md「M-13」）。
 * シートが関わる・ブラウザが自分で戻る動きを見せた（hasUAVisualTransition）・同じ画面の中（?tab= だけが変わる）なら none、
 * タブどうしは fade、それ以外は向きで push（進む）／pop（戻る）
 */
export function transitionKind(from: string, to: string, direction: "forward" | "back", uaTransition = false): TransitionKind {
  if (isSheetPath(from) || isSheetPath(to)) return "none";
  if (uaTransition) return "none";
  if (from === to) return "none";
  if (isTabPath(from) && isTabPath(to)) return "fade";
  return direction === "back" ? "pop" : "push";
}

/** popstate の向き：移った先の深さが直前より小さければ戻る */
export const directionOf = (fromDepth: number, toDepth: number): "forward" | "back" => (toDepth < fromDepth ? "back" : "forward");

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * 画面の切り替えを View Transitions で行う。使えない・動きを止める設定・動きの種類が none なら、そのまま切り替える（即時）。
 * 使えるときは、知らせるのを更新の関数の中まで待ち、flushSync で描き切る（その中でスクロールの位置も戻す）
 */
function runTransition(kind: TransitionKind) {
  const doc = document as ViewTransitionDocument;
  if (kind === "none" || typeof doc.startViewTransition !== "function" || prefersReducedMotion()) {
    notify();
    return;
  }
  const root = document.documentElement;
  root.dataset.nav = kind;
  const transition = doc.startViewTransition.call(doc, () => {
    flushSync(notify);
  });
  void transition.finished.finally(() => {
    if (root.dataset.nav === kind) delete root.dataset.nav;
  });
}

function onPopState(e: PopStateEvent) {
  const synthetic = navigating;
  navigating = false;
  const to = entryNow();
  const from = shown ?? to;
  shown = to;
  if (!synthetic) remember(from);
  const direction = synthetic ? "forward" : directionOf(from.depth, to.depth);
  const ua = !synthetic && (e as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true;
  const kind = transitionKind(from.path, to.path, direction, ua);
  // シートが関わるとき（後ろのタブは描き直さない）・同じ画面の中では、位置を動かさない
  if (isSheetPath(from.path) || isSheetPath(to.path) || from.path === to.path) pendingScroll = null;
  else if (synthetic) pendingScroll = isTabPath(to.path) ? tabScrollTarget(tabPositions, to.path) : 0;
  else pendingScroll = scrollTargetOnPop(entryPositions, tabPositions, { key: to.key, tab: isTabPath(to.path) ? to.path : null });
  runTransition(kind);
}

if (typeof window !== "undefined") window.addEventListener("popstate", onPopState);

export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.search };
}

/**
 * 移ったあとのスクロールの位置を、描いた直後に戻す（App で1回だけ使う）。
 * タブはタブごと、それ以外は履歴のエントリごと。初めての画面は一番上（docs/specs/T-56-motion.md「M-07」）
 */
export function useNavigationScroll() {
  const href = useSyncExternalStore(subscribe, snapshot);
  useLayoutEffect(() => {
    shown = entryNow();
    if (pendingScroll === null) return;
    const top = pendingScroll;
    pendingScroll = null;
    if (window.scrollY !== top) window.scrollTo({ top, behavior: "auto" });
  }, [href]);
}

export function navigate(to: string, { replace = false } = {}) {
  const from = entryNow();
  remember(from);
  if (replace) {
    // 置き換えるときは深さはそのまま、エントリの印は引き継がない
    window.history.replaceState({ ...(state() ?? {}), depth: from.depth, key: newKey() }, "", to);
  } else {
    const here = window.location.pathname;
    const behind = isTabPath(here) ? here + window.location.search : (state()?.behind ?? null);
    window.history.pushState({ inApp: true, behind, depth: from.depth + 1, key: newKey() } satisfies HistoryState, "", to);
  }
  shown = from;
  navigating = true;
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** 今の画面をアプリの中から開いたか（history.length はタブ全体の履歴なので使わない） */
export const openedInApp = () => state()?.inApp === true;

/** アプリの中から開いたシートの後ろに出していたタブの URL。外から直接開いたときは null */
export const behindTab = () => (openedInApp() ? (state()?.behind ?? null) : null);

/**
 * シート・設定などを閉じる。アプリの中から開いたときだけ1つ前に戻る。
 * メールやプッシュから直接開いたとき・再読み込みのあとは、アプリの外に出ないように fallback へ置き換えて移る
 */
export function goBack(fallback: string) {
  if (openedInApp()) window.history.back();
  else navigate(fallback, { replace: true });
}
