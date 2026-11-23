import { env } from "cloudflare:workers";
import { problemSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { handleCallback, providerEnabled, startLogin } from "./application/auth";

// Sign in with Apple を止める（docs/specs/T-12-release.md「Apple のログインを止める」）

let h: Awaited<ReturnType<typeof createHarness>>;

beforeEach(async () => {
  h = await createHarness();
});

const countTransactions = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM oauth_transactions").first<number>("n")) ?? 0;

describe("Apple を止める", () => {
  it("APPLE_LOGIN_ENABLED が \"1\" のときだけ Apple を使える。Google は値によらず使える", () => {
    for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
      expect(providerEnabled({ ...h.bindings, APPLE_LOGIN_ENABLED: value }, "apple"), String(value)).toBe(false);
      expect(providerEnabled({ ...h.bindings, APPLE_LOGIN_ENABLED: value }, "google")).toBe(true);
    }
    expect(providerEnabled({ ...h.bindings, APPLE_LOGIN_ENABLED: "1" }, "apple")).toBe(true);
  });

  for (const value of ["0", undefined, "true"]) {
    it(`止めた環境（${String(value)}）の start は、何も書かず、新しい結びつけ Cookie を出さずに login_failed への303`, async () => {
      h.bindings.APPLE_LOGIN_ENABLED = value;
      const before = await countTransactions();
      const res = await h.request("/api/v1/auth/apple/start?returnTo=%2Ffriends");
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe("/login?error=login_failed");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      // T-01 の失敗と同じく、結びつけ Cookie を消す Set-Cookie だけが出る
      const cookies = res.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThan(0);
      for (const c of cookies) {
        expect(c).toMatch(/^__Host-kh_oauth=;/);
        expect(c).toMatch(/Max-Age=0/i);
      }
      expect(await countTransactions()).toBe(before);
    });
  }

  it("止めた環境の callback は、本文を読まずに problem+json の404", async () => {
    h.bindings.APPLE_LOGIN_ENABLED = "0";
    const body = new ReadableStream({
      pull() {
        throw new Error("本文を読んではいけない");
      },
    });
    const res = await h.request("/api/v1/auth/apple/callback", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      // @ts-expect-error -- ストリームの本文に要る
      duplex: "half",
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect(problemSchema.parse(await res.json()).code).toBe("not_found");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("回数の上限（auth_start）は、Apple を止めていても先に効く", async () => {
    h.bindings.APPLE_LOGIN_ENABLED = "0";
    h.limiter.allow = () => false;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const res = await h.request("/api/v1/auth/apple/start", { headers: { "CF-Connecting-IP": "203.0.113.5" } });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/login?error=login_failed");
    expect(h.limiter.calls.at(-1)).toEqual({ limiter: "RL_PUBLIC", key: "auth_start:ip4:203.0.113.5" });
    vi.restoreAllMocks();
  });

  it("application の startLogin・handleCallback も、止めた Apple では何もせずに null", async () => {
    const ctx = { env: { ...h.bindings, APPLE_LOGIN_ENABLED: "0" }, deps: h.deps };
    const before = await countTransactions();
    expect(await startLogin(ctx, "apple", "/")).toBeNull();
    expect(await handleCallback(ctx, "apple", { code: "c", state: "s" }, "b")).toBeNull();
    expect(await countTransactions()).toBe(before);
    // Google は止めない
    expect(await startLogin(ctx, "google", "/")).not.toBeNull();
  });

  it("動かしている環境（\"1\"）では、今までどおり Apple の認可の画面へ送る", async () => {
    h.bindings.APPLE_LOGIN_ENABLED = "1";
    const s = await h.start("apple");
    expect(s.res.status).toBe(302);
    expect(s.location.origin).toBe("https://appleid.apple.com");
  });
});
