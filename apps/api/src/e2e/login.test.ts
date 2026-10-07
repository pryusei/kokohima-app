import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "./entry";

const login = (bindings: typeof env, user = `t-${crypto.randomUUID()}`) =>
  app.request(
    "/__e2e__/login",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user }) },
    bindings,
  );

describe("E2E用のテスト用ログイン", () => {
  it("E2E_MODE=1 のときだけ更新用トークンのCookieを発行する", async () => {
    const res = await login({ ...env, E2E_MODE: "1" });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-kh_rt="))).toBe(true);
  });

  it.each([undefined, "0", "true", ""])("E2E_MODE=%j なら404", async (mode) => {
    const res = await login({ ...env, E2E_MODE: mode });
    expect(res.status).toBe(404);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("user の形が不正なら400", async () => {
    const res = await login({ ...env, E2E_MODE: "1" }, "Not Allowed!");
    expect(res.status).toBe(400);
  });
});
