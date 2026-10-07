import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { PROBLEM_CONTENT_TYPE, type ErrorCode, type Problem } from "@kokohima/shared";
import type { AppEnv } from "./env";

export function problem(
  requestIdValue: string,
  status: number,
  code: ErrorCode,
  title: string,
): Response {
  const body: Problem = { type: "about:blank", title, status, code, requestId: requestIdValue };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": PROBLEM_CONTENT_TYPE },
  });
}

// 本番とE2Eで共有するアプリ本体。E2E用の経路はここに足さない（src/e2e/entry.ts で足す）
export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(requestId());

  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));

  app.notFound((c) => problem(c.get("requestId"), 404, "not_found", "Not Found"));

  // 例外の中身（スタックトレースや内部の値）はレスポンスに出さない
  app.onError((_err, c) =>
    problem(c.get("requestId"), 500, "internal_error", "Internal Server Error"),
  );

  return app;
}
