import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, ORIGIN } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";

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
      { limiter: "RL_PUBLIC", key: `auth_start:${IP}` },
      { limiter: "RL_PUBLIC", key: `auth_start:${IP}` },
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
    expect(h.limiter.calls).toEqual([{ limiter: "RL_PUBLIC", key: `invite_lookup:${IP}` }]);
  });

  it(".ics：超えたら本文なしの429", async () => {
    deny();
    const res = await h.request(`/api/v1/ics/${"t".repeat(43)}`, { headers: { "CF-Connecting-IP": IP } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.text()).toBe("");
    expect(h.limiter.calls).toEqual([{ limiter: "RL_PUBLIC", key: `ics:${IP}` }]);
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

  it("1回限りの値を消費する経路・refresh・連携の開始には付けない", async () => {
    deny();
    await u.user("あき");
    // ログイン（start は IP なしで上限をかけない）・コールバック・complete・refresh・authorizations
    const a = await u.user("べに");
    await u.call("POST", "/api/v1/calendar/google/authorizations", { token: a.token });
    await h.refresh(a.refreshToken);
    const keys = h.limiter.calls.map((c) => c.key);
    expect(keys.some((k) => /callback|complete|refresh|authorization/.test(k))).toBe(false);
  });

  it("本番で CF-Connecting-IP がなければ上限をかけず、記録だけ残す", async () => {
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
