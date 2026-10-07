import { authCompleteRequestSchema, authStartQuerySchema } from "@kokohima/shared";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { problem, problemFrom } from "../http/problem";
import * as auth from "./application/auth";
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

export function identityRoutes() {
  const app = new Hono<AppEnv>();

  for (const provider of ["google", "apple"] as const satisfies OidcProviderName[]) {
    app.get(`/auth/${provider}/start`, async (c) => {
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
    return c.body(null, 204);
  });

  app.post("/auth/logout-all", requireSameOrigin, requireAuth, requireActiveSession, async (c) => {
    await auth.logoutAll(ctx(c), c.var.viewer);
    clearRefreshCookie(c);
    return c.body(null, 204);
  });

  app.get("/me", requireAuth, async (c) => {
    const me = await auth.getMe(ctx(c), c.var.viewer.userId);
    if (!me) return problem(c.get("requestId"), 404, "not_found", "Not Found");
    return c.json(me);
  });

  return app;
}
