import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, ORIGIN } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { defaultDeps } from "../app";
import { clientKeyOf } from "./rateLimit";

// 回数の上限（docs/specs/T-10-idempotency-cache-ratelimit.md「回数の上限」）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const IP = "203.0.113.7";
const T = (s: string, day = "11") => `2026-10-${day}T${s}:00.000Z`;
const deny = () => {
  h.limiter.allow = () => false;
};

describe("Rate Limiting の経路", () => {
  it("ログインの開始：IP でまとまり auth_start を数え、超えたら /login?error=login_failed への303", async () => {
    deny();
    for (const provider of ["google", "apple"]) {
      const res = await h.request(`/api/v1/auth/${provider}/start`, { headers: { "CF-Connecting-IP": IP } });
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe("/login?error=login_failed");
      expect(res.headers.get("Content-Type")).toBeNull();
    }
    expect(h.limiter.calls).toEqual([
      { limiter: "RL_PUBLIC", key: `auth_start:ip4:${IP}` },
      { limiter: "RL_PUBLIC", key: `auth_start:ip4:${IP}` },
    ]);
    // 超えていなければ今までどおり認可画面へ
    h.limiter.allow = () => true;
    const ok = await h.request("/api/v1/auth/google/start", { headers: { "CF-Connecting-IP": IP } });
    expect(ok.status).toBe(302);
  });

  it("招待リンクの確認：超えたら429 rate_limited・Retry-After: 60", async () => {
    deny();
    const res = await h.request("/api/v1/invite-links/lookup", {
      method: "POST",
      headers: { "CF-Connecting-IP": IP, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x".repeat(43) }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(((await res.json()) as { code: string }).code).toBe("rate_limited");
    expect(h.limiter.calls).toEqual([{ limiter: "RL_PUBLIC", key: `invite_lookup:ip4:${IP}` }]);
  });

  it(".ics：超えたら本文なしの429", async () => {
    deny();
    const res = await h.request(`/api/v1/ics/${"t".repeat(43)}`, { headers: { "CF-Connecting-IP": IP } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.text()).toBe("");
    expect(h.limiter.calls).toEqual([{ limiter: "RL_PUBLIC", key: `ics:ip4:${IP}` }]);
  });

  it("カレンダーの空き：利用者 ID で数え、超えたら429", async () => {
    const a = await u.user("あき");
    h.limiter.calls.length = 0;
    deny();
    const res = await u.call("GET", `/api/v1/calendar/free-slots?from=${T("00:00", "10")}&to=${T("00:00", "12")}`, { token: a.token });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(h.limiter.calls).toEqual([{ limiter: "RL_USER", key: `free_slots:${a.id}` }]);
  });

  it("1回限りの値を消費する経路・refresh・連携の開始には付けない（IP を付けて送っても数えない）", async () => {
    const a = await u.user("あき");
    h.limiter.calls.length = 0;
    deny();
    const ipHeaders = { "CF-Connecting-IP": IP };
    await h.request("/api/v1/auth/google/callback?code=x&state=y", { headers: ipHeaders });
    await h.request("/api/v1/auth/apple/callback", {
      method: "POST",
      headers: { ...ipHeaders, "Content-Type": "application/x-www-form-urlencoded" },
      body: "code=x&state=y",
    });
    await h.request("/api/v1/auth/complete", {
      method: "POST",
      headers: { ...ipHeaders, Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "x" }),
    });
    await h.request("/api/v1/auth/refresh", { method: "POST", headers: { ...ipHeaders, Origin: ORIGIN, Cookie: `__Host-kh_rt=${a.refreshToken}` } });
    await h.request("/api/v1/calendar/google/callback?code=x&state=y", { headers: ipHeaders });
    await u.call("POST", "/api/v1/calendar/google/authorizations", { token: a.token, headers: ipHeaders });
    expect(h.limiter.calls).toEqual([]);
  });

  it("CF-Connecting-IP がなければ（どの環境でも）上限をかけず、記録だけ残す", async () => {
    const log = vi.spyOn(console, "log");
    deny();
    const res = await h.request("/api/v1/auth/google/start");
    expect(res.status).toBe(302);
    expect(h.limiter.calls).toHaveLength(0);
    expect(log.mock.calls.flat().join("\n")).toContain('"event":"rate_limit_skipped","group":"auth_start","reason":"no_client_ip"');
    log.mockRestore();
  });

  it("ログに IP と利用者 ID を出さない", async () => {
    const a = await u.user("あき");
    const log = vi.spyOn(console, "log");
    deny();
    await h.request("/api/v1/auth/google/start", { headers: { "CF-Connecting-IP": IP } });
    await u.call("GET", `/api/v1/calendar/free-slots?from=${T("00:00", "10")}&to=${T("00:00", "12")}`, { token: a.token });
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain('"event":"rate_limited"');
    expect(logged).not.toContain(IP);
    expect(logged).not.toContain(a.id);
    log.mockRestore();
  });

  it("本物のバインディング（Miniflare）でも、60秒に30回を超えると止まる", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const statuses: number[] = [];
    for (let n = 0; n < 40; n++) {
      const res = await h.request("/api/v1/auth/google/start", { headers: { "CF-Connecting-IP": ip } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 302)).toBe(true);
    expect(statuses.some((s) => s === 303)).toBe(true);
  });
});

describe(".ics リンクの発行数（D1）", () => {
  async function meetupOf() {
    const a = await u.user("あき");
    const b = await u.user("べに");
    await u.befriend(a, b);
    const invite = await u.call("POST", "/api/v1/direct-invites", {
      token: a.token,
      body: { recipientId: b.id, startsAt: T("02:00"), endsAt: T("03:00") },
    });
    const id = ((await invite.json()) as { id: string }).id;
    const accepted = await u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: b.token, body: { response: "accept" } });
    return { a, b, meetupId: ((await accepted.json()) as { meetupId: string }).meetupId };
  }
  const issue = (who: User, meetupId: string) => u.call("POST", `/api/v1/meetups/${meetupId}/ics-links`, { token: who.token });

  it("直近5分で20本まで。21本めは429で、Retry-After は最も古い行が5分を過ぎるまでの秒数", async () => {
    const { a, b, meetupId } = await meetupOf();
    const first = h.clock.now;
    for (let n = 0; n < 20; n++) {
      expect((await issue(a, meetupId)).status).toBe(200);
      h.clock.now += 1000;
    }
    const limited = await issue(a, meetupId);
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe("rate_limited");
    expect(limited.headers.get("Retry-After")).toBe(String(Math.ceil((first + 5 * 60 * 1000 - h.clock.now) / 1000)));
    // 別の利用者は数えない
    expect((await issue(b, meetupId)).status).toBe(200);
    // 5分を過ぎると発行できる
    h.clock.now = first + 5 * 60 * 1000 + 1;
    await u.advance(0, a, b);
    expect((await issue(a, meetupId)).status).toBe(200);
  });

  it("同時に送っても20本を超えない", async () => {
    const { a, meetupId } = await meetupOf();
    const results = await Promise.all(Array.from({ length: 25 }, () => issue(a, meetupId)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(20);
    expect(results.filter((r) => r.status === 429)).toHaveLength(5);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ics_tokens WHERE user_id = ?1").bind(a.id).first<{ n: number }>();
    expect(count?.n).toBe(20);
  });
});

describe("IP のまとめ方と、判定できないとき", () => {
  it("IPv4 はそのまま、IPv6 は /64 の接頭辞にまとめる。読めない値は null", () => {
    expect(clientKeyOf("203.0.113.7")).toBe("ip4:203.0.113.7");
    expect(clientKeyOf("2001:db8:1:2:3:4:5:6")).toBe("ip6:2001:db8:1:2");
    expect(clientKeyOf("2001:0db8:0001:0002::abcd")).toBe("ip6:2001:db8:1:2");
    expect(clientKeyOf("2001:db8::1")).toBe("ip6:2001:db8:0:0");
    expect(clientKeyOf("::1")).toBe("ip6:0:0:0:0");
    expect(clientKeyOf("::ffff:192.0.2.1")).toBe("ip6:0:0:0:0");
    expect(clientKeyOf("2001:DB8:1:2::")).toBe("ip6:2001:db8:1:2");
    for (const bad of ["", "unknown", "1:2:3", "2001:db8::1::2", "gggg::1", "1:2:3:4:5:6:7:8:9"]) {
      expect(clientKeyOf(bad), bad).toBeNull();
    }
  });

  it("同じ /64 の IPv6 は、アドレスが違っても同じ数え方になる", async () => {
    h.limiter.allow = () => true;
    for (const ip of ["2001:db8:aa:bb::1", "2001:db8:aa:bb:ffff:1:2:3"]) {
      await h.request("/api/v1/auth/google/start", { headers: { "CF-Connecting-IP": ip } });
    }
    expect(h.limiter.calls.map((c) => c.key)).toEqual(["auth_start:ip6:2001:db8:aa:bb", "auth_start:ip6:2001:db8:aa:bb"]);
  });

  it("バインディングがない・判定に失敗したときは、キーを出さずに記録を残して通す", async () => {
    const log = vi.spyOn(console, "log");
    const deps = defaultDeps();
    expect(await deps.rateLimit({ ...h.bindings, RL_PUBLIC: undefined }, "RL_PUBLIC", "auth_start:ip4:203.0.113.7")).toBe(true);
    const broken = {
      limit: async () => {
        throw new Error("down");
      },
    } as unknown as RateLimit;
    expect(await deps.rateLimit({ ...h.bindings, RL_USER: broken }, "RL_USER", "free_slots:someone")).toBe(true);
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toContain('"reason":"no_binding"');
    expect(logged).toContain('"reason":"error"');
    expect(logged).not.toMatch(/203\.0\.113\.7|someone/);
    log.mockRestore();
  });
});
