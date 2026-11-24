import { useSyncExternalStore } from "react";

// 画面が少ないうちは最小のルーター。URLが変わったら popstate で知らせる

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const url = new URL(href, window.location.origin);
  return { pathname: url.pathname, search: url.search };
}

/** 下のタブの URL（docs/specs/T-11-design.md「画面のつながり」） */
export const TAB_PATHS = ["/", "/availability", "/invites", "/friends"] as const;

/**
 * アプリの中の遷移で積む履歴の印。behind は、シートを開いたときに後ろに出していたタブの URL（?tab= も含む）。
 * タブからシートを開いたらそのタブ、シートからシートを開いたら前のシートの behind を引き継ぐ
 */
type HistoryState = { inApp: true; behind: string | null };

const state = () => window.history.state as Partial<HistoryState> | null;

/**
 * シートの差し替え（docs/specs/T-56-motion.md「M-03」）で覚えた、移る前のシートの高さ（px）。
 * 読んでも消さない（StrictMode で初期化が2回走っても同じ値を読めるように）。次の navigate・swapSheet・ブラウザの popstate で上書きする
 */
let swapped: { to: string; height: number } | null = null;

if (typeof window !== "undefined") {
  // ブラウザの戻る・進む（isTrusted）。navigate が自分で出す合成の popstate では消さない
  window.addEventListener("popstate", (e) => {
    if (e.isTrusted) swapped = null;
  });
}

/** 今の URL が swapSheet で移った先なら、移る前のシートの高さ（px）。それ以外は null */
export function swappedSheetHeight(): number | null {
  if (!swapped) return null;
  return swapped.to === window.location.pathname + window.location.search ? swapped.height : null;
}

/** 今のシートを、別の URL のシートへ置き換える（作成 → 詳細）。移る前に今のシートの高さを覚える */
export function swapSheet(to: string) {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  const height = dialog?.offsetHeight ?? 0;
  // 移った先の描画より先に覚える
  swapped = height > 0 ? { to, height } : null;
  go(to, true);
}

export function navigate(to: string, { replace = false } = {}) {
  swapped = null;
  go(to, replace);
}

function go(to: string, replace: boolean) {
  if (replace) {
    window.history.replaceState(window.history.state, "", to);
  } else {
    const here = window.location.pathname;
    const behind = (TAB_PATHS as readonly string[]).includes(here) ? here + window.location.search : (state()?.behind ?? null);
    window.history.pushState({ inApp: true, behind } satisfies HistoryState, "", to);
  }
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
