import { z } from "zod";
import type { Context } from "hono";
import { createSession } from "../identity/application/auth";
import { setRefreshCookie } from "../identity/cookies";
import { db, findOrCreateUser, updateDisplayName } from "../identity/infra/repository";
import { displayNameSchema } from "@kokohima/shared";
import { problem } from "../http/problem";
import type { AppEnv } from "../env";

// E2E用のテスト用ログイン。src/e2e/entry.ts からだけ読み込む（本番のエントリからの読み込みはESLintで禁止）

const e2eLoginSchema = z.object({
  user: z.string().regex(/^[a-z0-9-]{1,64}$/),
  // 相手を見分けるための表示名（T-02）
  displayName: displayNameSchema.optional(),
});

export async function e2eLogin(c: Context<AppEnv>) {
  const parsed = e2eLoginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return problem(c.get("requestId"), 400, "validation_failed", "Validation failed");
  const ctx = { env: c.env, deps: c.var.deps };
  const userId = await findOrCreateUser(db(c.env.DB), "e2e", parsed.data.user, null, ctx.deps.now());
  if (parsed.data.displayName) await updateDisplayName(db(c.env.DB), userId, parsed.data.displayName, ctx.deps.now());
  const issued = await createSession(ctx, userId, "e2e", c.req.header("User-Agent"));
  setRefreshCookie(c, issued.refreshToken, issued.refreshExpiresAt);
  return c.body(null, 204);
}
