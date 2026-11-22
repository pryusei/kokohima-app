import { authCompleteRequestSchema, authStartQuerySchema, updateMeRequestSchema, withdrawRequestSchema } from "@kokohima/shared";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { clearInviteCookie } from "../http/inviteCookie";
import { problem, problemFrom } from "../http/problem";
import { rateLimit } from "../http/rateLimit";
import { validationFailed } from "../http/validation";
import * as social from "../social/application/social";
import * as auth from "./application/auth";
import { withdraw } from "./application/withdrawal";
import {
  clearBindingCookie,
  clearRefreshCookie,
  getBindingCookie,
  getRefreshCookie,
  setBindingCookie,
  setRefreshCookie,
} from "./cookies";
import type { OidcProviderName } from "./infra/oidc";
import { requireActiveSession, requireAuth, requireSameOrigin } from "./middleware";

// 認証のAPI（docs/specs/T-01-auth.md「API」）

const ctx = (c: Context<AppEnv>) => ({ env: c.env, deps: c.var.deps });
// Cookieの削除を応答に残すため、c 経由で返す
const unauthenticated = (c: Context<AppEnv>) => problemFrom(c, 401, "unauthenticated", "Unauthorized");
const loginFailed = (c: Context<AppEnv>) => {
  clearBindingCookie(c);
  return c.redirect("/login?error=login_failed", 303);
};

// ログインの開始の回数の上限（T-10）。超えたらログイン画面の失敗へ（T-01 と同じ。JSON は返さない）
const authStartLimit = rateLimit({
  group: "auth_start",
  limiter: "RL_PUBLIC",
  by: "ip",
  onLimited: (c) => {
    c.header("Cache-Control", "no-store");
    return c.redirect("/login?error=login_failed", 303);
  },
});

export function identityRoutes() {
  const app = new Hono<AppEnv>();

  for (const provider of ["google", "apple"] as const satisfies OidcProviderName[]) {
    app.get(`/auth/${provider}/start`, authStartLimit, async (c) => {
      const parsed = authStartQuerySchema.safeParse(c.req.query());
      const returnTo = parsed.success ? parsed.data.returnTo : undefined;
      const { redirectUrl, binding } = await auth.startLogin(ctx(c), provider, returnTo);
      setBindingCookie(c, binding, provider);
      c.header("Cache-Control", "no-store");
      return c.redirect(redirectUrl, 302);
    });
  }

  const callback = async (c: Context<AppEnv>, provider: OidcProviderName, params: Record<string, unknown>) => {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const loginCode = await auth.handleCallback(
      ctx(c),
      provider,
      { code: str(params.code), state: str(params.state), error: str(params.error) },
      getBindingCookie(c),
    );
    if (!loginCode) return loginFailed(c);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    // コードはフラグメントに入れ、サーバーのログやRefererに残さない
    return c.redirect(`/auth/complete#code=${encodeURIComponent(loginCode)}`, 303);
  };
  app.get("/auth/google/callback", (c) => callback(c, "google", c.req.query()));
  app.post("/auth/apple/callback", async (c) => callback(c, "apple", await c.req.parseBody()));

  app.post("/auth/complete", requireSameOrigin, async (c) => {
    const body = authCompleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    const binding = getBindingCookie(c);
    clearBindingCookie(c);
    if (!body.success) return unauthenticated(c);
    const issued = await auth.completeLogin(ctx(c), body.data.code, binding, c.req.header("User-Agent"));
    if (!issued) return unauthenticated(c);
    setRefreshCookie(c, issued.refreshToken, issued.refreshExpiresAt);
    c.header("Cache-Control", "no-store");
    return c.json({ accessToken: issued.accessToken, expiresAt: issued.expiresAt, returnTo: issued.returnTo });
  });

  app.post("/auth/refresh", requireSameOrigin, async (c) => {
    const result = await auth.refresh(ctx(c), getRefreshCookie(c));
    if (result.kind !== "ok") {
      clearRefreshCookie(c);
      return unauthenticated(c);
    }
    setRefreshCookie(c, result.session.refreshToken, result.session.refreshExpiresAt);
    c.header("Cache-Control", "no-store");
    return c.json({ accessToken: result.session.accessToken, expiresAt: result.session.expiresAt });
  });

  app.post("/auth/logout", requireSameOrigin, async (c) => {
    await auth.logout(ctx(c), getRefreshCookie(c));
    clearRefreshCookie(c);
    // 共有の端末で、次の人に前の人の招待を引き継がない（T-02）
    clearInviteCookie(c);
    return c.body(null, 204);
  });

  app.post("/auth/logout-all", requireSameOrigin, requireAuth, requireActiveSession, async (c) => {
    await auth.logoutAll(ctx(c), c.var.viewer);
    // セッションを失効させてから無効にする（盗まれたトークンで、その間に新しいリンクを作らせない）
    await social.revokeAllInviteLinks(ctx(c), c.var.viewer.userId);
    clearRefreshCookie(c);
    clearInviteCookie(c);
    return c.body(null, 204);
  });

  // 表示名の設定（T-02）。閲覧者自身の行だけを更新する
  // 退会（T-16）。閲覧者本人だけ。経路にも本文にも利用者の ID を受けない
  app.post("/me/withdrawal", requireAuth, requireActiveSession, requireSameOrigin, async (c) => {
    const body = withdrawRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return validationFailed(c, body.error);
    const result = await withdraw(ctx(c), c.var.viewer);
    if (result === "unauthenticated") return unauthenticated(c);
    if (result === "reauth_required") {
      return problem(c.get("requestId"), 403, "reauth_required", "Forbidden");
    }
    clearRefreshCookie(c);
    clearBindingCookie(c);
    clearInviteCookie(c);
    return c.body(null, 204);
  });

  app.patch("/me", requireAuth, requireActiveSession, async (c) => {
    const body = updateMeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return validationFailed(c, body.error);
    const me = await auth.updateDisplayName(ctx(c), c.var.viewer.userId, body.data.displayName);
    if (!me) return problem(c.get("requestId"), 404, "not_found", "Not Found");
    return c.json(me);
  });

  app.get("/me", requireAuth, async (c) => {
    const me = await auth.getMe(ctx(c), c.var.viewer.userId);
    if (!me) return problem(c.get("requestId"), 404, "not_found", "Not Found");
    return c.json(me);
  });

  return app;
}
