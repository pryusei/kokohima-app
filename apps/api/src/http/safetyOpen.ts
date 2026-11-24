import { isSafetyOpen } from "@kokohima/shared";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { problem } from "./problem";

/**
 * ブロックと通報を始める日（docs/specs/T-33-block-report.md「振る舞い 8.」）より前は、認証より前に、
 * 知らない経路と同じ404（app.notFound と同じ応答）
 */
export const requireSafetyOpen = createMiddleware<AppEnv>(async (c, next) => {
  const { now, safetyStartAt } = c.var.deps;
  if (!isSafetyOpen(now(), safetyStartAt)) return problem(c.get("requestId"), 404, "not_found", "Not Found");
  await next();
});
