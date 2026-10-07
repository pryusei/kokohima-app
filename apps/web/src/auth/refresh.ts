import { refreshResponseSchema } from "@kokohima/shared";
import { tokenStore } from "./tokenStore";

// 更新用トークン（HttpOnly Cookie）でアクセストークンを取り直す。
// 複数タブの同時更新を Web Locks で直列化し、更新したタブは BroadcastChannel で新しいトークンを配る

export type RefreshOutcome = "ok" | "unauthenticated" | "error";

type Message =
  | { type: "token"; accessToken: string; expiresAt: string }
  | { type: "logout" };

const channel: BroadcastChannel | null =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("kh-auth");

const listeners = new Set<(m: Message) => void>();
channel?.addEventListener("message", (e: MessageEvent<Message>) => {
  if (e.data.type === "token") tokenStore.set(e.data.accessToken, e.data.expiresAt);
  if (e.data.type === "logout") tokenStore.clear();
  for (const l of listeners) l(e.data);
});

/** 他のタブからのログアウトなどを受け取る */
export function onAuthMessage(listener: (m: Message) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function broadcastLogout() {
  channel?.postMessage({ type: "logout" } satisfies Message);
}

async function doRefresh(versionAtStart: number): Promise<RefreshOutcome> {
  // ロックを待っている間に他のタブが更新していれば、それを使う
  if (tokenStore.version() !== versionAtStart && tokenStore.get()) return "ok";
  let res: Response;
  try {
    res = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "same-origin" });
  } catch {
    return "error";
  }
  if (res.status === 401) {
    tokenStore.clear();
    return "unauthenticated";
  }
  if (!res.ok) return "error";
  const parsed = refreshResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) return "error";
  tokenStore.set(parsed.data.accessToken, parsed.data.expiresAt);
  channel?.postMessage({ type: "token", ...parsed.data } satisfies Message);
  return "ok";
}

let inFlight: Promise<RefreshOutcome> | null = null;

export function refreshAccessToken(): Promise<RefreshOutcome> {
  // 同じタブの中の同時呼び出しは1回にまとめる
  if (inFlight) return inFlight;
  const versionAtStart = tokenStore.version();
  const run = () => doRefresh(versionAtStart);
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  inFlight = (locks ? locks.request("kh-refresh", run) : run())
    .catch((): RefreshOutcome => "error")
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
