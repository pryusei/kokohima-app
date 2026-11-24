import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { problem } from "../http/problem";
import type { AppEnv } from "../env";
import { isSessionActive } from "./application/auth";
import { verifyAccessToken } from "./infra/accessToken";

// 認証済みの閲覧者を c.var.viewer に入れる。失敗の理由（期限切れ・署名不正など）は応答で区別しない

function unauthenticated(requestId: string) {
  const res = problem(requestId, 401, "unauthenticated", "Unauthorized");
  res.headers.set("WWW-Authenticate", "Bearer");
  return res;
}

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/);
  const viewer = match?.[1] ? await verifyAccessToken(c.env, match[1], c.var.deps.now()) : null;
  if (!viewer) return unauthenticated(c.get("requestId"));
  c.set("viewer", viewer);
  await next();
});

/**
 * 認証を求めない経路用（招待リンクの lookup。T-33）：Bearer があって正しければ閲覧者 ID、なければ・正しくなければ null。
 * 401 にはしない（未ログインでも同じ経路を使うため）
 */
export async function optionalViewerId(c: Context<AppEnv>): Promise<string | null> {
  const header = c.req.header("Authorization");
  const match = header?.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/);
  const viewer = match?.[1] ? await verifyAccessToken(c.env, match[1], c.var.deps.now()) : null;
  return viewer?.userId ?? null;
}

/** 重要な操作用：requireAuth に加えて、セッションが失効していないことをD1で毎回確認する */
export const requireActiveSession = createMiddleware<AppEnv>(async (c, next) => {
  const active = await isSessionActive({ env: c.env, deps: c.var.deps }, c.var.viewer);
  if (!active) return unauthenticated(c.get("requestId"));
  await next();
});

/** 自サイト以外からのCookie付きリクエストを拒否する（Originが無い場合も拒否） */
export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header("Origin") !== c.env.APP_ORIGIN) return unauthenticated(c.get("requestId"));
  await next();
});

/**
 * 書き込みの経路用（T-16）：GET・HEAD 以外では requireActiveSession と同じ確認をする。
 * 退会・ログアウトのあとに残ったアクセストークンでは書き込めない。冪等キーの処理より前に置く
 */
export const requireActiveSessionForWrites = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const active = await isSessionActive({ env: c.env, deps: c.var.deps }, c.var.viewer);
    if (!active) return unauthenticated(c.get("requestId"));
  }
  await next();
});
