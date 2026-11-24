import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../env";
import { e2eApp as app } from "./entry";
import { e2eLineFetch } from "./line";

// E2E の偽の LINE ログイン（docs/specs/T-32-line-login.md「E2E用の偽の LINE」）

const ORIGIN = env.APP_ORIGIN;
const bindings = { ...env, E2E_MODE: "1" } as Bindings;
const cookieOf = (res: Response, name: string) =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(";")[0] ?? "";

describe("偽の LINE ログイン", () => {
  it("開始 → 偽の認可画面 → コールバック → 完了まで通り、新しい利用者になる", async () => {
    const start = await app.request("/api/v1/auth/line/start?returnTo=/friends", {}, bindings);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("Location") ?? "");
    expect(authorize.toString()).toMatch(/^http:\/\/localhost:8787\/__e2e__\/line\/authorize\?/);
    const binding = cookieOf(start, "__Host-kh_oauth");

    const consented = await app.request(`${authorize.pathname}${authorize.search}`, {}, bindings);
    expect(consented.status).toBe(302);
    const back = new URL(consented.headers.get("Location") ?? "");
    expect(back.origin + back.pathname).toBe(`${ORIGIN}/api/v1/auth/line/callback`);

    const callback = await app.request(`${back.pathname}${back.search}`, { headers: { Cookie: binding } }, bindings);
    expect(callback.status).toBe(303);
    const code = decodeURIComponent((callback.headers.get("Location") ?? "").replace(/^\/auth\/complete#code=/, ""));
    expect(code).not.toContain("/");

    const complete = await app.request(
      "/api/v1/auth/complete",
      { method: "POST", headers: { Origin: ORIGIN, Cookie: binding, "Content-Type": "application/json" }, body: JSON.stringify({ code }) },
      bindings,
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ returnTo: "/friends" });
  });

  it("偽の認可画面は E2E_MODE=1 のときだけ。APP_ORIGIN の外へは戻さない", async () => {
    const q = new URLSearchParams({ redirect_uri: `${ORIGIN}/api/v1/auth/line/callback`, state: "s", nonce: "n", code_challenge_method: "S256" });
    expect((await app.request(`/__e2e__/line/authorize?${q}`, {}, { ...env, E2E_MODE: undefined } as Bindings)).status).toBe(404);
    q.set("redirect_uri", "https://evil.example/cb");
    expect((await app.request(`/__e2e__/line/authorize?${q}`, {}, bindings)).status).toBe(404);
  });

  it("偽の verify は、チャネル ID か nonce が違えば 400", async () => {
    const code = `e2e-line-${btoa(JSON.stringify({ sub: "Ux", nonce: "n1" }))}`;
    const token = e2eLineFetch(new URL("https://line.e2e.invalid/oauth2/v2.1/token"), { method: "POST", body: new URLSearchParams({ code, code_verifier: "v" }) }, "c1", 0);
    const idToken = ((await token?.json()) as { id_token: string }).id_token;
    const verify = (clientId: string, nonce: string) =>
      e2eLineFetch(new URL("https://line.e2e.invalid/oauth2/v2.1/verify"), { method: "POST", body: new URLSearchParams({ id_token: idToken, client_id: clientId, nonce }) }, "c1", 0);
    expect(verify("c1", "n1")?.status).toBe(200);
    expect(verify("c2", "n1")?.status).toBe(400);
    expect(verify("c1", "n2")?.status).toBe(400);
    expect(e2eLineFetch(new URL("https://api.line.me/oauth2/v2.1/verify"), undefined, "c1", 0)).toBeNull();
  });
});
