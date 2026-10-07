import { expect } from "vitest";
import { cookieValue, createHarness, ORIGIN } from "./identity-harness";

// 複数の利用者と友達関係を作るテスト用の道具（T-03以降のテストで使う）

export type Harness = Awaited<ReturnType<typeof createHarness>>;
export type User = { id: string; token: string; refreshToken: string; name: string };

export function makeUsers(h: Harness) {
  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; cookie?: string; origin?: string | null } = {},
  ) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.origin !== null) headers.Origin = opts.origin ?? ORIGIN;
    return h.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  }

  async function user(name = "テスト"): Promise<User> {
    const r = await h.login("google", `sub-${crypto.randomUUID()}`);
    expect((await call("PATCH", "/api/v1/me", { token: r.accessToken, body: { displayName: name } })).status).toBe(200);
    const me = (await (await call("GET", "/api/v1/me", { token: r.accessToken })).json()) as { id: string };
    return { id: me.id, token: r.accessToken, refreshToken: r.refreshToken, name };
  }

  /** a のリンクで b が友達になる */
  async function befriend(a: User, b: User) {
    const res = await call("POST", "/api/v1/invite-links", { token: a.token, body: {} });
    const link = (await res.json()) as { id: string; url: string };
    const token = decodeURIComponent(link.url.split("#t=")[1] ?? "");
    const accepted = await call("POST", "/api/v1/invite-links/accept", {
      token: b.token,
      body: { linkId: link.id },
      cookie: `__Host-kh_invite=${token}`,
    });
    expect(accepted.status).toBe(201);
  }

  /** 時計を進め、アクセストークンを取り直す */
  async function advance(ms: number, ...users: User[]) {
    h.clock.now += ms;
    for (const u of users) {
      const res = await h.refresh(u.refreshToken);
      expect(res.status).toBe(200);
      u.token = ((await res.json()) as { accessToken: string }).accessToken;
      u.refreshToken = cookieValue(res, "__Host-kh_rt") ?? "";
    }
  }

  return { call, user, befriend, advance };
}
