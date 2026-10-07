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

export function navigate(to: string, { replace = false } = {}) {
  if (replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
