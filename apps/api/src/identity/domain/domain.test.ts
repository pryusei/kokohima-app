import { describe, expect, it } from "vitest";
import { deviceSummary } from "./deviceSummary";
import { verifiedEmail } from "./idTokenClaims";
import { checkLineClaims } from "./lineIdToken";
import { decideRefresh, nextTokenExpiry, REFRESH_TOKEN_TTL_MS, RESCUE_WINDOW_MS } from "./refresh";
import { sanitizeReturnTo } from "./returnTo";

const ORIGIN = "http://localhost:5173";

describe("sanitizeReturnTo", () => {
  it.each(["/", "/friends", "/invite/abc?x=1#y"])("同じオリジンのパス %s はそのまま", (v) => {
    expect(sanitizeReturnTo(v, ORIGIN)).toBe(v);
  });

  it.each([
    undefined,
    "",
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/ /evil.example",
    "relative",
    "/api/v1/auth/google/start",
    "/api",
    "/__e2e__/login",
    "/__anything",
    `/${"a".repeat(512)}`,
  ])("危険・不正な値 %j は / に置き換える", (v) => {
    expect(sanitizeReturnTo(v, ORIGIN)).toBe("/");
  });
});

describe("deviceSummary", () => {
  it("ブラウザとOSの要約だけを返す", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
    expect(deviceSummary(ua)).toBe("Safari / iOS");
    expect(deviceSummary(ua)).not.toContain("Mozilla");
  });

  it("判別できなければ unknown", () => {
    expect(deviceSummary(null)).toBe("unknown");
    expect(deviceSummary("curl/8.0")).toBe("unknown");
  });
});

describe("verifiedEmail", () => {
  it("Googleは email_verified が true のときだけ", () => {
    expect(verifiedEmail("google", { sub: "1", email: "a@example.com", email_verified: true })).toBe("a@example.com");
    expect(verifiedEmail("google", { sub: "1", email: "a@example.com", email_verified: "true" })).toBeNull();
    expect(verifiedEmail("google", { sub: "1", email: "a@example.com", email_verified: false })).toBeNull();
  });

  it("Appleは文字列の \"true\" も確認済みとして扱い、false は保存しない", () => {
    expect(verifiedEmail("apple", { sub: "1", email: "x@privaterelay.appleid.com", email_verified: "true" })).toBe(
      "x@privaterelay.appleid.com",
    );
    expect(verifiedEmail("apple", { sub: "1", email: "x@example.com", email_verified: "false" })).toBeNull();
  });

  it("LINE は確認済みでもメールアドレスを返さない（email のスコープを求めていない。T-32）", () => {
    expect(verifiedEmail("line", { sub: "U1", email: "a@example.com", email_verified: true })).toBeNull();
  });
});

describe("checkLineClaims（T-32）", () => {
  const now = Date.parse("2026-11-24T00:00:00Z");
  const sec = now / 1000;
  const good = { iss: "https://access.line.me", aud: "123", sub: "U1", iat: sec, exp: sec + 600, nonce: "n" };
  const check = (p: unknown) => checkLineClaims(p, { channelId: "123", now });

  it("正しいクレームなら sub と nonce を返す", () => {
    expect(check(good)).toEqual({ ok: true, claims: { sub: "U1", nonce: "n" } });
  });

  it("期限は60秒まで許す。過ぎたら失敗。iat が60秒より先でも失敗", () => {
    expect(check({ ...good, exp: sec - 59 }).ok).toBe(true);
    expect(check({ ...good, exp: sec - 60 }).ok).toBe(false);
    expect(check({ ...good, iat: sec + 60 }).ok).toBe(true);
    expect(check({ ...good, iat: sec + 61 }).ok).toBe(false);
  });

  it.each([
    ["発行者が違う", { iss: "https://access.line.me/" }],
    ["宛先が違う", { aud: "456" }],
    ["宛先が配列", { aud: ["123"] }],
    ["exp が文字列", { exp: String(sec + 600) }],
    ["iat がない", { iat: undefined }],
    ["nonce がない", { nonce: undefined }],
    ["nonce が空", { nonce: "" }],
    ["sub がない", { sub: undefined }],
    ["sub が長すぎる", { sub: "U".repeat(256) }],
  ])("%s なら失敗", (_name, patch) => {
    expect(check({ ...good, ...patch }).ok).toBe(false);
  });

  it("オブジェクトでなければ失敗", () => {
    expect(check(null).ok).toBe(false);
    expect(check("x").ok).toBe(false);
  });
});

describe("decideRefresh", () => {
  const now = 1_000_000;
  const live = { expiresAt: now + 1000, revokedAt: null };
  const unused = { expiresAt: now + 1000, usedAt: null };
  const used = { expiresAt: now + 1000, usedAt: now - 10 };

  it("未使用のトークンは交換する", () => {
    expect(decideRefresh(unused, live, null, now).kind).toBe("rotate");
  });

  it("使用済みで次のトークンが未使用なら、24時間以内は救済する", () => {
    const recent = { expiresAt: now + 1000, usedAt: now - RESCUE_WINDOW_MS + 1 };
    expect(decideRefresh(recent, live, unused, now).kind).toBe("rescue");
  });

  it("使用済みから24時間を過ぎたら、次のトークンが未使用でも救済せず再利用として扱う", () => {
    const old = { expiresAt: now + 1000, usedAt: now - RESCUE_WINDOW_MS };
    expect(decideRefresh(old, live, unused, now).kind).toBe("reuse");
  });

  it("救済で使用済みにされたトークンが提示されたら再利用（交互の救済で検知を逃さない）", () => {
    const rescued = { expiresAt: now + 1000, usedAt: now - 10, rescuedAt: now - 10 };
    expect(decideRefresh(rescued, live, unused, now).kind).toBe("reuse");
  });

  it("救済で交換する次のトークンが期限切れなら拒否", () => {
    expect(decideRefresh(used, live, { expiresAt: now, usedAt: null }, now).kind).toBe("reject");
  });

  it("使用済みで次のトークンも使用済みなら再利用", () => {
    expect(decideRefresh(used, live, used, now).kind).toBe("reuse");
    expect(decideRefresh(used, live, null, now).kind).toBe("reuse");
  });

  it("トークンの期限切れ、セッションの失効・期限切れは拒否", () => {
    expect(decideRefresh({ expiresAt: now, usedAt: null }, live, null, now).kind).toBe("reject");
    expect(decideRefresh(unused, { expiresAt: now + 1, revokedAt: now - 1 }, null, now).kind).toBe("reject");
    expect(decideRefresh(unused, { expiresAt: now, revokedAt: null }, null, now).kind).toBe("reject");
    // 期限切れの使用済みトークンは、救済も再利用の判定もせずに拒否する
    expect(decideRefresh({ expiresAt: now, usedAt: now - 1 }, live, unused, now).kind).toBe("reject");
    expect(decideRefresh({ expiresAt: now, usedAt: now - 1 }, live, used, now).kind).toBe("reject");
  });

  it("新しいトークンの期限はセッションの絶対期限を超えない", () => {
    expect(nextTokenExpiry(now, now + 5)).toBe(now + 5);
    expect(nextTokenExpiry(now, now + REFRESH_TOKEN_TTL_MS * 10)).toBe(now + REFRESH_TOKEN_TTL_MS);
  });
});
