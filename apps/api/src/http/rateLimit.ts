import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppEnv, RateLimiterName } from "../env";
import { problem } from "./problem";

// 回数の上限（レート制限。docs/specs/T-10-idempotency-cache-ratelimit.md「回数の上限」）
// キーは「まとまりの名前:IP か利用者ID」。ログには IP と利用者 ID を出さない

export type RateLimitGroup = "auth_start" | "invite_lookup" | "ics" | "free_slots";

const RETRY_AFTER_SECONDS = "60";

/**
 * 数えるための IP。IPv6 は /64 の接頭辞にまとめる（1つの回線が /64 を持てるので、アドレスごとに数えると上限を回避できる）。
 * 読めない値は null（上限をかけない）
 */
export function clientKeyOf(ip: string): string | null {
  const value = ip.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `ip4:${value}`;
  if (!value.includes(":")) return null;
  const [head = "", tail = ""] = value.toLowerCase().split("::", 2);
  if (value.split("::").length > 2) return null;
  const left = head === "" ? [] : head.split(":");
  const right = tail === "" ? [] : tail.split(":");
  // IPv4 を埋め込んだ末尾（::ffff:1.2.3.4 など）は2つ分の区切りとして数える
  const last = right.length > 0 ? right[right.length - 1] : left[left.length - 1];
  const extra = last?.includes(".") ? 1 : 0;
  const missing = 8 - left.length - right.length - extra;
  if (!value.includes("::") && missing !== 0) return null;
  if (missing < 0) return null;
  const groups = [...left, ...Array<string>(value.includes("::") ? missing : 0).fill("0"), ...right];
  const prefix = groups.slice(0, 4);
  if (prefix.length < 4 || prefix.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return `ip6:${prefix.map((g) => g.replace(/^0+(?=.)/, "")).join(":")}`;
}

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
      const ip = c.req.header("CF-Connecting-IP");
      subject = ip ? (clientKeyOf(ip) ?? undefined) : undefined;
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
