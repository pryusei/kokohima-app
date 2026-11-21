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

/** アプリの中の遷移で積んだ履歴の印（docs/specs/T-11-design.md「画面のつながり」） */
const IN_APP = { inApp: true } as const;

export function navigate(to: string, { replace = false } = {}) {
  if (replace) window.history.replaceState(window.history.state, "", to);
  else window.history.pushState(IN_APP, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** 今の画面をアプリの中から開いたか（history.length はタブ全体の履歴なので使わない） */
export const openedInApp = () => (window.history.state as { inApp?: unknown } | null)?.inApp === true;

/**
 * シート・設定などを閉じる。アプリの中から開いたときだけ1つ前に戻る。
 * メールやプッシュから直接開いたとき・再読み込みのあとは、アプリの外に出ないように fallback へ置き換えて移る
 */
export function goBack(fallback: string) {
  if (openedInApp()) window.history.back();
  else navigate(fallback, { replace: true });
}
