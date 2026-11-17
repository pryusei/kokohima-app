import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv, RateLimiterName } from "../env";
import { problem } from "./problem";

// 回数の上限（レート制限。docs/specs/T-10-idempotency-cache-ratelimit.md「回数の上限」）
// キーは「まとまりの名前:IP か利用者ID」。ログには IP と利用者 ID を出さない

export type RateLimitGroup = "auth_start" | "invite_lookup" | "ics" | "free_slots";

const RETRY_AFTER_SECONDS = "60";

export const rateLimitedProblem = (c: Context<AppEnv>) => {
  const res = problem(c.get("requestId"), 429, "rate_limited", "Too Many Requests");
  res.headers.set("Retry-After", RETRY_AFTER_SECONDS);
  return res;
};

type Options = {
  group: RateLimitGroup;
  limiter: RateLimiterName;
  /** ip：認証なしの経路。user：認証の後に付ける */
  by: "ip" | "user";
  /** 上限を超えたときの応答（既定は429 rate_limited） */
  onLimited?: (c: Context<AppEnv>) => Response;
};

export function rateLimit(options: Options) {
  return createMiddleware<AppEnv>(async (c, next) => {
    let subject: string | undefined;
    if (options.by === "user") {
      subject = c.get("viewer")?.userId;
      if (!subject) throw new Error("rateLimit by user requires an authenticated viewer");
    } else {
      subject = c.req.header("CF-Connecting-IP") ?? undefined;
      if (!subject) {
        // ヘッダーがないと全員が1つの数え方にまとまるので、上限をかけない
        console.log(JSON.stringify({ event: "rate_limit_skipped", group: options.group, reason: "no_client_ip" }));
        return next();
      }
    }
    const allowed = await c.var.deps.rateLimit(c.env, options.limiter, `${options.group}:${subject}`);
    if (!allowed) {
      console.log(JSON.stringify({ event: "rate_limited", group: options.group }));
      return (options.onLimited ?? rateLimitedProblem)(c);
    }
    await next();
  });
}
