import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { e2eApp as app } from "./entry";

// E2E用の偽の Google の経路（docs/specs/T-06-calendar.md「E2E用の偽のGoogle」）は E2E_MODE=1 のときだけ有効

describe("E2E用のカレンダーの経路", () => {
  it.each([undefined, "0", ""])("E2E_MODE=%j なら、認証より前に404", async (mode) => {
    const bindings = { ...env, E2E_MODE: mode };
    for (const [method, path] of [
      ["GET", "/__e2e__/calendar/google/authorize?state=x&redirect_uri=https%3A%2F%2Fapp.test%2F"],
      ["POST", "/__e2e__/calendar/busy"],
      ["POST", "/__e2e__/calendar/sync"],
      ["POST", "/__e2e__/outbox/drain"],
    ] as const) {
      expect((await app.request(path, { method }, bindings)).status).toBe(404);
    }
  });

  it("E2E_MODE=1 でも、認証が要る経路は未ログインで401。知らない state の認可画面は404", async () => {
    const bindings = { ...env, E2E_MODE: "1" };
    expect((await app.request("/__e2e__/calendar/busy", { method: "POST" }, bindings)).status).toBe(401);
    expect((await app.request("/__e2e__/outbox/drain", { method: "POST" }, bindings)).status).toBe(401);
    const authorize = await app.request(
      `/__e2e__/calendar/google/authorize?state=unknown&redirect_uri=${encodeURIComponent(`${env.APP_ORIGIN}/api/v1/calendar/google/callback`)}`,
      {},
      bindings,
    );
    expect(authorize.status).toBe(404);
  });
});
