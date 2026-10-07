import { PROBLEM_CONTENT_TYPE, type ErrorCode, type Problem } from "@kokohima/shared";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// APIのエラー形式（RFC 9457 Problem Details）
export function problem(
  requestId: string,
  status: number,
  code: ErrorCode,
  title: string,
  errors?: Problem["errors"],
): Response {
  const body: Problem = { type: "about:blank", title, status, code, requestId, ...(errors ? { errors } : {}) };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
  });
}

/** c.header() や setCookie() で積んだヘッダー（Cookieの削除など）を残したままエラーを返す */
export function problemFrom(
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  code: ErrorCode,
  title: string,
): Response {
  const body: Problem = { type: "about:blank", title, status, code, requestId: c.get("requestId") };
  return c.body(JSON.stringify(body), status, { "Content-Type": PROBLEM_CONTENT_TYPE });
}
