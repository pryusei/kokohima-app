import { Hono } from "hono";
import { requestId } from "hono/request-id";
import { createRemoteJWKSet } from "jose";
import type { AppDeps, AppEnv } from "./env";
import { problem } from "./http/problem";
import { identityRoutes } from "./identity/routes";
import { socialRoutes } from "./social/routes";

export { problem };

function defaultDeps(): AppDeps {
  return {
    fetch: (input, init) => fetch(input, init),
    jwks: {
      google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
      apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys")),
    },
    now: () => Date.now(),
  };
}

// 本番とE2Eで共有するアプリ本体。E2E用の経路はここに足さない（src/e2e/entry.ts で足す）
export function createApp(overrides: Partial<AppDeps> = {}): Hono<AppEnv> {
  const deps: AppDeps = { ...defaultDeps(), ...overrides };
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  app.get("/api/v1/health", (c) => c.json({ status: "ok" }));
  app.route("/api/v1", identityRoutes());
  app.route("/api/v1", socialRoutes());

  app.notFound((c) => problem(c.get("requestId"), 404, "not_found", "Not Found"));

  // 例外の中身（スタックトレースや内部の値）はレスポンスにもログにも出さない
  app.onError((err, c) => {
    console.error(JSON.stringify({ event: "unhandled_error", requestId: c.get("requestId"), name: err.name }));
    return problem(c.get("requestId"), 500, "internal_error", "Internal Server Error");
  });

  return app;
}

