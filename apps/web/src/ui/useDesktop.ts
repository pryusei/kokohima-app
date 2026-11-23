import { useSyncExternalStore } from "react";

// PC の配置かどうか（docs/specs/T-20-desktop-layout.md「画面の大きさの区切り」）。Tailwind の `lg:` と同じ区切り
export const DESKTOP_QUERY = "(min-width: 64rem)";

const media = () => (typeof window.matchMedia === "function" ? window.matchMedia(DESKTOP_QUERY) : null);

function subscribe(callback: () => void) {
  const m = media();
  m?.addEventListener("change", callback);
  return () => m?.removeEventListener("change", callback);
}

const getSnapshot = () => media()?.matches ?? false;

/** 幅1024px以上なら true。幅が変わると描き直す */
export function useDesktop() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
