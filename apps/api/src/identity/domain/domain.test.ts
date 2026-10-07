import { describe, expect, it } from "vitest";
import { deviceSummary } from "./deviceSummary";
import { verifiedEmail } from "./idTokenClaims";
import { decideRefresh, nextTokenExpiry, REFRESH_TOKEN_TTL_MS } from "./refresh";
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
});

describe("decideRefresh", () => {
  const now = 1_000_000;
  const live = { expiresAt: now + 1000, revokedAt: null };
  const unused = { expiresAt: now + 1000, usedAt: null };
  const used = { expiresAt: now + 1000, usedAt: now - 10 };

  it("未使用のトークンは交換する", () => {
    expect(decideRefresh(unused, live, null, now).kind).toBe("rotate");
  });

  it("使用済みで次のトークンが未使用なら救済する（時間の制限なし）", () => {
    const longAgo = { expiresAt: now + 1000, usedAt: now - 10 * 24 * 3600 * 1000 };
    expect(decideRefresh(longAgo, live, unused, now).kind).toBe("rescue");
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
