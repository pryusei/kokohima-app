import type { ZodType } from "zod";
import { refreshAccessToken } from "../auth/refresh";
import { tokenStore } from "../auth/tokenStore";

// APIクライアント。アクセストークン（メモリ）を付け、401なら1回だけ更新して再送する

/** status が 0 のときは通信できなかったことを表す。code は Problem Details の code（読めたときだけ） */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null = null,
    /** Problem Details の本文（読めたときだけ。拡張の項目を読むときに使う） */
    readonly problem: Record<string, unknown> | null = null,
  ) {
    super(`API error ${status}`);
  }
}

/** Idempotency-Key の衝突（同じキーの処理中・内容の違う使い回し）。今の画面の 409 の扱いとは分ける（T-10） */
export const isIdempotencyConflict = (error: unknown) =>
  error instanceof ApiError && (error.code === "request_in_progress" || error.code === "idempotency_key_mismatch");

async function problemOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.clone().json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
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
  if (!res.ok) {
    const body = await problemOf(res);
    throw new ApiError(res.status, typeof body?.code === "string" ? body.code : null, body);
  }
  return res;
}

/** レスポンスを packages/shared のスキーマで検証してから返す */
export async function apiGet<T>(path: string, schema: ZodType<T>): Promise<T> {
  const res = await apiFetch(path);
  return schema.parse(await res.json());
}

/** JSON を送り、レスポンスを検証して返す（本文のない 204 なら undefined） */
export async function apiSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body: unknown,
  schema?: ZodType<T>,
  options: { idempotencyKey?: string } = {},
): Promise<T | undefined> {
  const headers = options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : undefined;
  const res = await apiFetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!schema || res.status === 204) return undefined;
  return schema.parse(await res.json());
}
