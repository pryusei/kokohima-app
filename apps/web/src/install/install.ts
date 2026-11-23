import { useSyncExternalStore } from "react";

// ホーム画面に追加する（docs/specs/T-25-installable-pwa.md）
// `beforeinstallprompt` は画面を開く前に来ることがあるので、起動時に受けてメモリ（この変数）にだけ置く。ブラウザには保存しない

type InstallPromptEvent = Event & { prompt: () => Promise<unknown> };
type Snapshot = { canPrompt: boolean; justInstalled: boolean };

let deferred: InstallPromptEvent | null = null;
let snapshot: Snapshot = { canPrompt: false, justInstalled: false };
const listeners = new Set<() => void>();

function update(next: Snapshot) {
  snapshot = next;
  for (const l of listeners) l();
}

/** 起動時に1回だけ呼ぶ */
export function startInstallListener() {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    update({ ...snapshot, canPrompt: true });
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    update({ canPrompt: false, justInstalled: true });
  });
}

/** 保存したイベントで追加のダイアログを開く。1回しか呼べないので、先に捨てる。結果は見ない（閉じても静かに扱う） */
export async function promptInstall() {
  const event = deferred;
  if (!event) return;
  deferred = null;
  update({ ...snapshot, canPrompt: false });
  try {
    await event.prompt();
  } catch {
    // 拒否されても何も出さない
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** ホーム画面から開いているか。matchMedia・navigator.standalone がない環境では false */
function isStandalone() {
  const viaMedia = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  return viaMedia || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function subscribeStandalone(cb: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia("(display-mode: standalone)");
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

export function isIos() {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export type InstallMode = "standalone" | "installed" | "prompt" | "ios" | "other";

/** 案内の状態。standalone → 追加した直後 → ボタン → iOS の手順 → それ以外、の順で最初に当てはまるもの */
export function useInstallMode(): InstallMode {
  const standalone = useSyncExternalStore(subscribeStandalone, isStandalone);
  const state = useSyncExternalStore(subscribe, () => snapshot);
  if (standalone) return "standalone";
  if (state.justInstalled) return "installed";
  if (state.canPrompt) return "prompt";
  return isIos() ? "ios" : "other";
}

/** テスト用：保存したイベントと状態を空にする */
export function resetInstallState() {
  deferred = null;
  update({ canPrompt: false, justInstalled: false });
}
