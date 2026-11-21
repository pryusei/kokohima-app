import { useSyncExternalStore } from "react";

// オンラインかどうか（docs/specs/T-11-design.md「オフライン」）。キャッシュはせず、表示と送る操作の停止にだけ使う

function subscribe(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

export function useOnline() {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}
