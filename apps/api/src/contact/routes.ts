import { contactMessageRequestSchema, isContactOpen, reportRequestSchema } from "@kokohima/shared";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { bodyLimit } from "../http/bodyLimit";
import { idempotent } from "../http/idempotency";
import { requireSafetyOpen } from "../http/safetyOpen";
import { problem } from "../http/problem";
import { validationFailed } from "../http/validation";
import { requireActiveSession, requireAuth, requireSameOrigin } from "../identity/middleware";
import { submitReport } from "./application/report";
import { submitContactMessage } from "./application/submit";

// 問い合わせの API（docs/specs/T-24-contact.md「API」）。ミドルウェアと処理の順番は固定：
// 公開の日 → requireAuth → requireActiveSession → requireSameOrigin → 本文の上限 → idempotent → 検証 → 受け付け

/** 本文の上限（UTF-8 のバイト数）。内容の上限（1000文字）をすべて4バイトの文字で書き、JSON のエスケープを足しても収まる */
export const CONTACT_REQUEST_MAX_BYTES = 8192;

/** 公開の日より前は、認証より前に、知らない経路と同じ404（app.notFound と同じ応答） */
const requireContactOpen = createMiddleware<AppEnv>(async (c, next) => {
  const { now, contactStartAt } = c.var.deps;
  if (!isContactOpen(now(), contactStartAt)) return problem(c.get("requestId"), 404, "not_found", "Not Found");
  await next();
});

export function contactRoutes() {
  const app = new Hono<AppEnv>();
  app.post(
    "/contact-messages",
    requireContactOpen,
    requireAuth,
    requireActiveSession,
    requireSameOrigin,
    bodyLimit(CONTACT_REQUEST_MAX_BYTES),
    idempotent,
    async (c) => {
      const body = contactMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return validationFailed(c, body.error);
      const result = await submitContactMessage({ env: c.env, deps: c.var.deps }, c.var.viewer.userId, body.data);
      if (result.kind === "unauthenticated") {
        const res = problem(c.get("requestId"), 401, "unauthenticated", "Unauthorized");
        res.headers.set("WWW-Authenticate", "Bearer");
        return res;
      }
      if (result.kind === "rate_limited") {
        // T-10 の共通の rate_limited と同じ形（利用者 ID は出さない）
        console.log(JSON.stringify({ event: "rate_limited", group: "contact_messages" }));
        const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
        res.headers.set("Retry-After", String(result.retryAfterSeconds));
        return res;
      }
      return c.body(null, 204);
    },
  );
  return app;
}

/** 通報の本文の上限。くわしく（1000文字）が問い合わせの内容と同じ上限なので、同じ値にする */
export const REPORT_REQUEST_MAX_BYTES = CONTACT_REQUEST_MAX_BYTES;

/**
 * 通報の API（docs/specs/T-33-block-report.md「API」）。順番は問い合わせと同じで固定：
 * 始める日 → requireAuth → requireActiveSession → requireSameOrigin → 本文の上限 → idempotent → 検証 → 受け付け
 */
export function reportRoutes() {
  const app = new Hono<AppEnv>();
  app.post(
    "/reports",
    requireSafetyOpen,
    requireAuth,
    requireActiveSession,
    requireSameOrigin,
    bodyLimit(REPORT_REQUEST_MAX_BYTES),
    idempotent,
    async (c) => {
      const body = reportRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return validationFailed(c, body.error);
      const result = await submitReport({ env: c.env, deps: c.var.deps }, c.var.viewer.userId, body.data);
      switch (result.kind) {
        case "not_found":
          return problem(c.get("requestId"), 404, "not_found", "Not Found");
        case "unauthenticated": {
          const res = problem(c.get("requestId"), 401, "unauthenticated", "Unauthorized");
          res.headers.set("WWW-Authenticate", "Bearer");
          return res;
        }
        case "rate_limited": {
          console.log(JSON.stringify({ event: "rate_limited", group: "reports" }));
          const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
          res.headers.set("Retry-After", String(result.retryAfterSeconds));
          return res;
        }
        default:
          return c.body(null, 204);
      }
    },
  );
  return app;
}
