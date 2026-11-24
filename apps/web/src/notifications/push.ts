import { vapidKeySchema } from "@kokohima/shared";
import { apiGet, apiSend } from "../api/client";

// プッシュの購読（docs/specs/T-07-notification.md「プッシュの購読と Service Worker」）
// サーバーに送るのは endpoint と、中身の暗号化の鍵（p256dh・auth。T-35）だけ。Service Worker にはアクセストークンを渡さない

export const pushSupported = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

const decodeKey = (base64url: string) => {
  const b64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
};

/** 登録の本文：endpoint と暗号化の鍵（docs/specs/T-35-notification-visibility.md）。鍵が取れなければ endpoint だけ */
export function subscriptionBody(subscription: PushSubscription) {
  const keys = subscription.toJSON().keys;
  return keys?.p256dh && keys.auth
    ? { endpoint: subscription.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }
    : { endpoint: subscription.endpoint };
}

/** この端末がプッシュを受け取る状態か */
export async function pushEnabled() {
  return pushSupported() && Notification.permission === "granted" && (await currentSubscription()) !== null;
}

/** アプリを開いたとき：許可済みで購読があれば、endpoint と鍵を送り直す（冪等。T-35 より前の購読にも鍵が付く）。失敗しても何もしない */
export async function resendSubscription() {
  try {
    if (!pushSupported() || Notification.permission !== "granted") return;
    const subscription = await currentSubscription();
    if (subscription) await apiSend("POST", "/api/v1/push/subscriptions", subscriptionBody(subscription));
  } catch {
    // 次に開いたときに送り直す
  }
}

/** 許可を取り、購読して登録する。許可されなければ false */
export async function enablePush() {
  if (!pushSupported()) return false;
  if ((await Notification.requestPermission()) !== "granted") return false;
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await apiGet("/api/v1/push/vapid-key", vapidKeySchema);
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: decodeKey(publicKey),
  });
  await apiSend("POST", "/api/v1/push/subscriptions", subscriptionBody(subscription));
  return true;
}

/** この端末の購読をやめる */
export async function disablePush() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await apiSend("DELETE", "/api/v1/push/subscriptions", { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/** ログアウトの前：この端末の購読を消す。呼べなくても、サーバーがセッションの購読を消す */
export async function removeSubscriptionBeforeLogout() {
  try {
    const subscription = await currentSubscription();
    if (subscription) await apiSend("DELETE", "/api/v1/push/subscriptions", { endpoint: subscription.endpoint });
  } catch {
    // サーバー側で消える
  }
}

/** 退会のあと（T-16）：この端末の購読をブラウザでも解除する（サーバーの行は退会で消えている）。失敗しても何もしない */
export async function unsubscribeLocally() {
  try {
    const subscription = await currentSubscription();
    await subscription?.unsubscribe();
  } catch {
    // ブラウザが対応していない・すでに解除されている
  }
}
