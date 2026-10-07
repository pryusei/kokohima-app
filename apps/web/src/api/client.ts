import type { ZodType } from "zod";
import { refreshAccessToken } from "../auth/refresh";
import { tokenStore } from "../auth/tokenStore";

// APIクライアント。アクセストークン（メモリ）を付け、401なら1回だけ更新して再送する

/** status が 0 のときは通信できなかったことを表す */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`API error ${status}`);
  }
}

let onUnauthenticated: () => void = () => {};

/** 更新にも失敗したときに呼ばれる（ログアウト状態にする） */
export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = tokenStore.get();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!tokenStore.get()) {
    const outcome = await refreshAccessToken();
    // ログインしていなければ、本来のリクエストを送らずにログアウト状態にする（更新を2回走らせない）
    if (outcome === "unauthenticated") {
      onUnauthenticated();
      throw new ApiError(401);
    }
  }
  let res: Response;
  try {
    res = await send(path, init);
  } catch {
    throw new ApiError(0);
  }
  if (res.status === 401) {
    const outcome = await refreshAccessToken();
    if (outcome === "unauthenticated") {
      onUnauthenticated();
      throw new ApiError(401);
    }
    // 通信できない・5xx はログアウトとして扱わない（ログイン状態を保ったまま失敗を返す）
    if (outcome === "error") throw new ApiError(0);
    try {
      res = await send(path, init);
    } catch {
      throw new ApiError(0);
    }
    if (res.status === 401) {
      tokenStore.clear();
      onUnauthenticated();
      throw new ApiError(401);
    }
  }
  if (!res.ok) throw new ApiError(res.status);
  return res;
}

/** レスポンスを packages/shared のスキーマで検証してから返す */
export async function apiGet<T>(path: string, schema: ZodType<T>): Promise<T> {
  const res = await apiFetch(path);
  return schema.parse(await res.json());
}
