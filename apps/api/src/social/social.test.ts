import { env } from "cloudflare:workers";
import {
  acceptInviteResponseSchema,
  createdInviteLinkSchema,
  friendPageSchema,
  inviteLinkPageSchema,
  inviteLookupResponseSchema,
  problemSchema,
} from "@kokohima/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { cookieHeader, cookieValue, createHarness, ORIGIN } from "../../test/identity-harness";
import { REPAIR_AFTER_MS } from "./application/social";
import { DAY_MS, isUsable, issueRetryAfterSeconds } from "./domain/inviteLink";

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

type User = { id: string; token: string; refreshToken: string };

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

async function user(displayName: string | null = "テスト"): Promise<User> {
  const r = await h.login("google", `sub-${crypto.randomUUID()}`);
  if (displayName) {
    const res = await call("PATCH", "/api/v1/me", { token: r.accessToken, body: { displayName } });
    expect(res.status).toBe(200);
  }
  const me = (await (await call("GET", "/api/v1/me", { token: r.accessToken })).json()) as { id: string };
  return { id: me.id, token: r.accessToken, refreshToken: r.refreshToken };
}

/** 時計を進め、アクセストークン（10分）が切れた利用者のトークンを取り直す */
async function advance(ms: number, ...users: User[]) {
  h.clock.now += ms;
  for (const u of users) {
    const res = await h.refresh(u.refreshToken);
    expect(res.status).toBe(200);
    u.token = ((await res.json()) as { accessToken: string }).accessToken;
    u.refreshToken = cookieValue(res, "__Host-kh_rt") ?? "";
  }
}

async function createLink(owner: User, body: unknown = {}) {
  const res = await call("POST", "/api/v1/invite-links", { token: owner.token, body });
  expect(res.status).toBe(201);
  const link = createdInviteLinkSchema.parse(await res.json());
  return { ...link, token: decodeURIComponent(link.url.split("#t=")[1] ?? "") };
}

/** 受け口の流れ：lookup で招待Cookieを受け取り、accept する */
async function lookup(token: string | undefined, cookie?: string) {
  return call("POST", "/api/v1/invite-links/lookup", { body: token ? { token } : {}, cookie });
}

async function accept(viewer: User, cookieToken: string | undefined, linkId: string) {
  return call("POST", "/api/v1/invite-links/accept", {
    token: viewer.token,
    body: { linkId },
    cookie: cookieToken ? `__Host-kh_invite=${cookieToken}` : undefined,
  });
}

async function befriend(owner: User, viewer: User) {
  const link = await createLink(owner);
  const res = await accept(viewer, link.token, link.id);
  expect(res.status).toBe(201);
  return link;
}

async function friendsOf(u: User) {
  return friendPageSchema.parse(await (await call("GET", "/api/v1/friends", { token: u.token })).json());
}

async function dbAll<T>(query: string, ...params: unknown[]) {
  return (await env.DB.prepare(query).bind(...params).all<T>()).results;
}

describe("domain", () => {
  it("isUsable：無効化・期限切れ・上限は使えない", () => {
    const base = { maxUses: 2, uses: 1, expiresAt: 100, revokedAt: null };
    expect(isUsable(base, 50)).toBe(true);
    expect(isUsable({ ...base, revokedAt: 10 }, 50)).toBe(false);
    expect(isUsable(base, 100)).toBe(false);
    expect(isUsable({ ...base, uses: 2 }, 50)).toBe(false);
  });

  it("issueRetryAfterSeconds：24時間に20本まで", () => {
    const now = 10 * DAY_MS;
    const times = Array.from({ length: 19 }, (_, i) => now - i * 1000);
    expect(issueRetryAfterSeconds(times, now)).toBeNull();
    expect(issueRetryAfterSeconds([...times, now - DAY_MS + 60_000], now)).toBe(60);
    expect(issueRetryAfterSeconds([...times, now - DAY_MS - 1], now)).toBeNull();
  });
});

describe("表示名", () => {
  it("前後の空白を除いて1〜20文字。制御文字や21文字以上は400", async () => {
    const r = await h.login("google", `sub-${crypto.randomUUID()}`);
    const ok = await call("PATCH", "/api/v1/me", { token: r.accessToken, body: { displayName: "  ゆうせい  " } });
    expect(((await ok.json()) as { displayName: string }).displayName).toBe("ゆうせい");
    for (const displayName of ["", "   ", "a".repeat(21), "a\u0007b"]) {
      const res = await call("PATCH", "/api/v1/me", { token: r.accessToken, body: { displayName } });
      expect(res.status).toBe(400);
    }
  });

  it("閲覧者自身の行だけを更新する（body の id は無視される）", async () => {
    const a = await user("A");
    const b = await user("B");
    await call("PATCH", "/api/v1/me", { token: a.token, body: { displayName: "A2", id: b.id } });
    const rows = await dbAll<{ display_name: string }>("SELECT display_name FROM users WHERE id = ?", b.id);
    expect(rows[0]?.display_name).toBe("B");
  });
});

describe("招待リンクの発行・一覧・無効化", () => {
  it("トークンは32バイトのbase64urlで、D1にはハッシュだけ。url は発行時だけ返す", async () => {
    const a = await user();
    const link = await createLink(a);
    expect(link.url).toBe(`${ORIGIN}/invite#t=${link.token}`);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link).toMatchObject({ maxUses: 5, uses: 0 });
    expect(Date.parse(link.expiresAt) - Date.parse(link.createdAt)).toBe(3 * DAY_MS);
    const rows = await dbAll<{ token_hash: string }>("SELECT token_hash FROM invite_links WHERE id = ?", link.id);
    expect(rows[0]?.token_hash).not.toBe(link.token);
    const list = await (await call("GET", "/api/v1/invite-links", { token: a.token })).text();
    expect(list).not.toContain(link.token);
    expect(list).not.toContain("url");
  });

  it("期限・人数の入力検証", async () => {
    const a = await user();
    for (const body of [{ expiresInDays: 2 }, { maxUses: 0 }, { maxUses: 11 }, { maxUses: 1.5 }]) {
      expect((await call("POST", "/api/v1/invite-links", { token: a.token, body })).status).toBe(400);
    }
    const custom = await createLink(a, { expiresInDays: 7, maxUses: 10 });
    expect(custom.maxUses).toBe(10);
  });

  it("表示名が未設定なら409", async () => {
    const a = await user(null);
    const res = await call("POST", "/api/v1/invite-links", { token: a.token, body: {} });
    expect(res.status).toBe(409);
    expect(problemSchema.parse(await res.json()).code).toBe("invalid_state");
  });

  it("24時間に20本を超えると429と Retry-After", async () => {
    const a = await user();
    for (let i = 0; i < 20; i++) await createLink(a);
    const res = await call("POST", "/api/v1/invite-links", { token: a.token, body: {} });
    expect(res.status).toBe(429);
    expect(problemSchema.parse(await res.json()).code).toBe("rate_limited");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    await advance(DAY_MS, a);
    expect((await call("POST", "/api/v1/invite-links", { token: a.token, body: {} })).status).toBe(201);
  });

  it("24時間に20本の上限は、同時に送られても超えない", async () => {
    const a = await user();
    for (let i = 0; i < 18; i++) await createLink(a);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call("POST", "/api/v1/invite-links", { token: a.token, body: {} })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);
    const rows = await dbAll("SELECT id FROM invite_links WHERE owner_id = ?", a.id);
    expect(rows).toHaveLength(20);
  });

  it("一覧：有効なリンクだけを新しい順で返し、カーソルで続きを取れる", async () => {
    const a = await user();
    const links = [];
    for (let i = 0; i < 3; i++) {
      links.push(await createLink(a));
      h.clock.now += 1000;
    }
    const revoked = await createLink(a);
    await call("POST", `/api/v1/invite-links/${revoked.id}/revoke`, { token: a.token });
    const full = await createLink(a, { maxUses: 1 });
    await accept(await user(), full.token, full.id);
    const all = inviteLinkPageSchema.parse(await (await call("GET", "/api/v1/invite-links", { token: a.token })).json());
    expect(all.items.map((l) => l.id)).not.toContain(revoked.id);
    expect(all.items.map((l) => l.id)).not.toContain(full.id);
    const page1 = inviteLinkPageSchema.parse(
      await (await call("GET", "/api/v1/invite-links?limit=2", { token: a.token })).json(),
    );
    expect(page1.items.map((l) => l.id)).toEqual([links[2]?.id, links[1]?.id]);
    const page2 = inviteLinkPageSchema.parse(
      await (await call("GET", `/api/v1/invite-links?limit=2&cursor=${page1.nextCursor}`, { token: a.token })).json(),
    );
    expect(page2.items.map((l) => l.id)).toEqual([links[0]?.id]);
    expect(page2.nextCursor).toBeNull();
    expect((await call("GET", "/api/v1/invite-links?cursor=broken", { token: a.token })).status).toBe(400);
  });

  it("一覧：他人のリンクは含まない（カーソルで続きを取っても）", async () => {
    const a = await user();
    const b = await user();
    await createLink(a);
    await createLink(a);
    const bLink = await createLink(b);
    const p1 = inviteLinkPageSchema.parse(await (await call("GET", "/api/v1/invite-links?limit=1", { token: a.token })).json());
    const p2 = inviteLinkPageSchema.parse(
      await (await call("GET", `/api/v1/invite-links?limit=1&cursor=${p1.nextCursor}`, { token: a.token })).json(),
    );
    const ids = [...p1.items, ...p2.items].map((l) => l.id);
    expect(ids).toHaveLength(2);
    expect(ids).not.toContain(bLink.id);
    expect(p2.nextCursor).toBeNull();
  });

  it("一覧：期限切れのリンクは含まない", async () => {
    const a = await user();
    const short = await createLink(a, { expiresInDays: 1 });
    const long = await createLink(a, { expiresInDays: 3 });
    await advance(DAY_MS, a);
    const page = inviteLinkPageSchema.parse(await (await call("GET", "/api/v1/invite-links", { token: a.token })).json());
    expect(page.items.map((l) => l.id)).toEqual([long.id]);
    expect(page.items.map((l) => l.id)).not.toContain(short.id);
  });

  it("無効化：自分のリンクは何度でも204。他人のリンク・存在しないIDは同じ404", async () => {
    const a = await user();
    const b = await user();
    const link = await createLink(a);
    expect((await call("POST", `/api/v1/invite-links/${link.id}/revoke`, { token: b.token })).status).toBe(404);
    expect((await lookup(link.token)).status).toBe(200); // B の操作で無効化されていない
    expect((await call("POST", `/api/v1/invite-links/${link.id}/revoke`, { token: a.token })).status).toBe(204);
    expect((await call("POST", `/api/v1/invite-links/${link.id}/revoke`, { token: a.token })).status).toBe(204);
    const other = await call("POST", `/api/v1/invite-links/${crypto.randomUUID()}/revoke`, { token: a.token });
    expect(other.status).toBe(404);
  });
});

describe("受け口（lookup）", () => {
  it("有効なら linkId と発行者の表示名・アイコン（IDは含まない）を返し、招待Cookieを発行する", async () => {
    const a = await user("あき");
    const link = await createLink(a);
    const res = await lookup(link.token);
    expect(res.status).toBe(200);
    const body = inviteLookupResponseSchema.parse(await res.json());
    expect(body).toEqual({ linkId: link.id, inviter: { displayName: "あき", avatarUrl: null } });
    expect(JSON.stringify(body)).not.toContain(a.id);
    const cookie = cookieHeader(res, "__Host-kh_invite") ?? "";
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Max-Age=3600/);
  });

  it("本文がなければ招待Cookieのトークンで発行者を返す。Cookieもなければ404", async () => {
    const a = await user("あき");
    const link = await createLink(a);
    const res = await lookup(undefined, `__Host-kh_invite=${link.token}`);
    expect(inviteLookupResponseSchema.parse(await res.json()).linkId).toBe(link.id);
    expect((await lookup(undefined)).status).toBe(404);
  });

  it("長すぎるトークンも400ではなく同じ404", async () => {
    expect((await lookup("x".repeat(500))).status).toBe(404);
  });

  it("存在しない・期限切れ・上限・無効化は、すべて同じ404で、招待Cookieを消す", async () => {
    const a = await user();
    const expired = await createLink(a, { expiresInDays: 1 });
    const full = await createLink(a, { maxUses: 1 });
    await accept(await user(), full.token, full.id);
    const revoked = await createLink(a);
    await call("POST", `/api/v1/invite-links/${revoked.id}/revoke`, { token: a.token });
    h.clock.now += DAY_MS;
    const bodies = [];
    for (const token of ["unknown-token", expired.token, full.token, revoked.token]) {
      const res = await lookup(token);
      expect(res.status).toBe(404);
      expect(cookieValue(res, "__Host-kh_invite")).toBe("");
      const body = problemSchema.parse(await res.json());
      bodies.push(JSON.stringify({ ...body, requestId: "" }));
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it("Origin がない・別のOriginは401", async () => {
    const link = await createLink(await user());
    expect((await call("POST", "/api/v1/invite-links/lookup", { body: { token: link.token }, origin: null })).status).toBe(401);
    expect(
      (await call("POST", "/api/v1/invite-links/lookup", { body: { token: link.token }, origin: "https://evil.example" }))
        .status,
    ).toBe(401);
  });
});

describe("友達になる（accept）", () => {
  it("両方向の行と FriendshipEstablished 2件ができ、人数が1増える。招待Cookieを消す", async () => {
    const a = await user("発行者さん");
    const b = await user("B");
    const link = await createLink(a);
    const res = await accept(b, link.token, link.id);
    expect(res.status).toBe(201);
    expect(cookieValue(res, "__Host-kh_invite")).toBe("");
    const body = acceptInviteResponseSchema.parse(await res.json());
    expect(body).toEqual({ friend: { id: a.id, displayName: "発行者さん", avatarUrl: null }, alreadyFriends: false });
    expect((await friendsOf(a)).items.map((f) => f.id)).toEqual([b.id]);
    expect((await friendsOf(b)).items.map((f) => f.id)).toEqual([a.id]);
    const events = await dbAll<{ payload: string }>(
      "SELECT payload FROM outbox WHERE type = 'FriendshipEstablished' AND (payload LIKE ? OR payload LIKE ?)",
      `%"userId":"${a.id}"%`,
      `%"userId":"${b.id}"%`,
    );
    expect(events.map((e) => JSON.parse(e.payload).userId).sort()).toEqual([a.id, b.id].sort());
    expect(events.map((e) => e.payload).join()).not.toContain("発行者さん");
    const rows = await dbAll<{ uses: number }>("SELECT uses FROM invite_links WHERE id = ?", link.id);
    expect(rows[0]?.uses).toBe(1);
  });

  it("すでに友達なら200で、人数が増えない", async () => {
    const a = await user();
    const b = await user();
    const link = await befriend(a, b);
    const res = await accept(b, link.token, link.id);
    expect(res.status).toBe(200);
    expect(cookieValue(res, "__Host-kh_invite")).toBe("");
    expect(acceptInviteResponseSchema.parse(await res.json()).alreadyFriends).toBe(true);
    expect((await dbAll<{ uses: number }>("SELECT uses FROM invite_links WHERE id = ?", link.id))[0]?.uses).toBe(1);
  });

  it("同じ人が同時に2回送っても、人数は1、FriendshipEstablished は2件だけ", async () => {
    const a = await user();
    const b = await user();
    const link = await createLink(a);
    const results = await Promise.all([accept(b, link.token, link.id), accept(b, link.token, link.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect((await dbAll<{ uses: number }>("SELECT uses FROM invite_links WHERE id = ?", link.id))[0]?.uses).toBe(1);
    const events = await dbAll("SELECT id FROM outbox WHERE type = 'FriendshipEstablished' AND payload LIKE ?", `%${b.id}%`);
    expect(events).toHaveLength(2);
  });

  it("上限1のリンクを2人が同時に使うと、1人だけ友達になる", async () => {
    const a = await user();
    const [b, c] = [await user(), await user()];
    const link = await createLink(a, { maxUses: 1 });
    const results = await Promise.all([accept(b, link.token, link.id), accept(c, link.token, link.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 404]);
    expect((await friendsOf(a)).items).toHaveLength(1);
    const loser = results[0]?.status === 404 ? b : c;
    expect((await friendsOf(loser)).items).toHaveLength(0);
  });

  it("自分のリンクは409", async () => {
    const a = await user();
    const link = await createLink(a);
    const res = await accept(a, link.token, link.id);
    expect(res.status).toBe(409);
    expect(cookieValue(res, "__Host-kh_invite")).toBe("");
    expect(problemSchema.parse(await res.json()).code).toBe("invalid_state");
  });

  it("期限切れ・上限・無効化・招待Cookieなしは404", async () => {
    const a = await user();
    const b = await user();
    const revoked = await createLink(a);
    await call("POST", `/api/v1/invite-links/${revoked.id}/revoke`, { token: a.token });
    const revokedRes = await accept(b, revoked.token, revoked.id);
    expect(revokedRes.status).toBe(404);
    expect(cookieValue(revokedRes, "__Host-kh_invite")).toBe("");
    const full = await createLink(a, { maxUses: 1 });
    await accept(await user(), full.token, full.id);
    expect((await accept(b, full.token, full.id)).status).toBe(404);
    const link = await createLink(a, { expiresInDays: 1 });
    expect((await accept(b, undefined, link.id)).status).toBe(404);
    await advance(DAY_MS, b);
    expect((await accept(b, link.token, link.id)).status).toBe(404);
    expect((await friendsOf(b)).items).toHaveLength(0);
  });

  it("表示したリンクと招待Cookieのリンクが違えば404で、友達にならず、招待Cookieは消さない", async () => {
    const x = await user("X");
    const y = await user("Y");
    const b = await user();
    const linkX = await createLink(x);
    const linkY = await createLink(y);
    // タブ1でXのリンクを表示し、タブ2でYのリンクを開いてCookieが上書きされた
    const res = await accept(b, linkY.token, linkX.id);
    expect(res.status).toBe(404);
    expect(cookieValue(res, "__Host-kh_invite")).toBeUndefined();
    expect((await friendsOf(b)).items).toHaveLength(0);
  });

  it("Origin がない・別のOriginなら401", async () => {
    const link = await createLink(await user());
    const b = await user();
    for (const origin of [null, "https://evil.example"]) {
      const res = await call("POST", "/api/v1/invite-links/accept", {
        token: b.token,
        body: { linkId: link.id },
        cookie: `__Host-kh_invite=${link.token}`,
        origin,
      });
      expect(res.status).toBe(401);
    }
    expect((await friendsOf(b)).items).toHaveLength(0);
  });

  it("401（トークンなし）では招待Cookieを消さない", async () => {
    const link = await createLink(await user());
    const res = await call("POST", "/api/v1/invite-links/accept", {
      body: { linkId: link.id },
      cookie: `__Host-kh_invite=${link.token}`,
    });
    expect(res.status).toBe(401);
    expect(cookieValue(res, "__Host-kh_invite")).toBeUndefined();
  });

  it("途中で落ちて閲覧者側の行だけが残った状態から、人数を消費せずに修復する", async () => {
    const a = await user();
    const b = await user();
    const link = await createLink(a);
    // 手順5と6の間で落ちた状態を作る（閲覧者側の行と人数の消費だけ）
    await env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)")
      .bind(b.id, a.id, h.clock.now - REPAIR_AFTER_MS)
      .run();
    await env.DB.prepare("UPDATE invite_links SET uses = 1 WHERE id = ?").bind(link.id).run();
    expect((await friendsOf(a)).items).toHaveLength(0);

    const res = await accept(b, link.token, link.id);
    expect(res.status).toBe(200);
    expect((await friendsOf(a)).items.map((f) => f.id)).toEqual([b.id]);
    expect((await dbAll<{ uses: number }>("SELECT uses FROM invite_links WHERE id = ?", link.id))[0]?.uses).toBe(1);
    const events = await dbAll("SELECT id FROM outbox WHERE type = 'FriendshipEstablished' AND payload LIKE ?", `%${b.id}%`);
    expect(events).toHaveLength(2);
  });

  it("解除した相手が同じリンクで友達に戻れる（人数を消費する）", async () => {
    const a = await user();
    const b = await user();
    const link = await befriend(a, b);
    expect((await call("DELETE", `/api/v1/friends/${a.id}`, { token: b.token })).status).toBe(204);
    expect((await accept(b, link.token, link.id)).status).toBe(201);
    expect((await dbAll<{ uses: number }>("SELECT uses FROM invite_links WHERE id = ?", link.id))[0]?.uses).toBe(2);
  });
});

describe("友達一覧・解除・公開設定", () => {
  it("一覧：自分の友達だけを新しい順で返し、公開プロフィールと自分の公開設定だけを含む", async () => {
    const a = await user("A");
    const [b, c] = [await user("B"), await user("C")];
    await befriend(a, b);
    h.clock.now += 1000;
    await befriend(a, c);
    await befriend(b, await user("D")); // B の友達は A の一覧に出ない
    // B は A に暇を見せない設定にしている（A には返さない）
    await call("PATCH", `/api/v1/friends/${a.id}`, { token: b.token, body: { sharesMyAvailability: false } });

    const page = await friendsOf(a);
    expect(page.items.map((f) => f.id)).toEqual([c.id, b.id]);
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(
      ["avatarUrl", "displayName", "friendsSince", "id", "sharesMyAvailability"].sort(),
    );
    expect(page.items.every((f) => f.sharesMyAvailability)).toBe(true);
    const text = JSON.stringify(page);
    expect(text).not.toContain("@");
  });

  it("一覧のカーソル", async () => {
    const a = await user();
    for (let i = 0; i < 3; i++) {
      await befriend(a, await user());
      h.clock.now += 1000;
    }
    const p1 = friendPageSchema.parse(await (await call("GET", "/api/v1/friends?limit=2", { token: a.token })).json());
    const p2 = friendPageSchema.parse(
      await (await call("GET", `/api/v1/friends?limit=2&cursor=${p1.nextCursor}`, { token: a.token })).json(),
    );
    expect(p1.items).toHaveLength(2);
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((f) => f.id)).size).toBe(3);
  });

  it("解除：両方向が消え、outboxに何も書かれない。友達でない・存在しないユーザーは同じ404", async () => {
    const a = await user();
    const b = await user();
    const stranger = await user();
    await befriend(a, b);
    const before = (await dbAll("SELECT id FROM outbox")).length;
    expect((await call("DELETE", `/api/v1/friends/${b.id}`, { token: a.token })).status).toBe(204);
    expect((await friendsOf(a)).items).toHaveLength(0);
    expect((await friendsOf(b)).items).toHaveLength(0);
    expect((await dbAll("SELECT id FROM outbox")).length).toBe(before);
    expect((await call("DELETE", `/api/v1/friends/${stranger.id}`, { token: a.token })).status).toBe(404);
    expect((await call("DELETE", `/api/v1/friends/${crypto.randomUUID()}`, { token: a.token })).status).toBe(404);
  });

  it("公開設定：保存されて一覧に反映され、解除して友達に戻っても残る。友達でない人には404", async () => {
    const a = await user();
    const b = await user();
    const link = await befriend(a, b);
    const res = await call("PATCH", `/api/v1/friends/${b.id}`, { token: a.token, body: { sharesMyAvailability: false } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sharesMyAvailability: boolean }).sharesMyAvailability).toBe(false);
    expect((await friendsOf(a)).items[0]?.sharesMyAvailability).toBe(false);

    await call("DELETE", `/api/v1/friends/${b.id}`, { token: a.token });
    await accept(b, link.token, link.id);
    expect((await friendsOf(a)).items[0]?.sharesMyAvailability).toBe(false);

    const stranger = await user();
    expect(
      (await call("PATCH", `/api/v1/friends/${stranger.id}`, { token: a.token, body: { sharesMyAvailability: false } }))
        .status,
    ).toBe(404);
    expect((await dbAll("SELECT * FROM sharing_policies WHERE target_id = ?", stranger.id))).toHaveLength(0);
  });

  it("他人のIDでは取得・更新できない：A は B–C 間の解除や公開設定を変えられない", async () => {
    const a = await user();
    const b = await user();
    const c = await user();
    await befriend(b, c);
    expect((await call("DELETE", `/api/v1/friends/${c.id}`, { token: a.token })).status).toBe(404);
    expect(
      (await call("PATCH", `/api/v1/friends/${c.id}`, { token: a.token, body: { sharesMyAvailability: false } })).status,
    ).toBe(404);
    expect((await friendsOf(b)).items.map((f) => f.id)).toEqual([c.id]);
    expect((await friendsOf(a)).items).toHaveLength(0);
  });

  it("認証がなければ401", async () => {
    expect((await call("GET", "/api/v1/friends")).status).toBe(401);
    expect((await call("POST", "/api/v1/invite-links", { body: {} })).status).toBe(401);
  });
});

describe("ログアウトで招待Cookieも消す", () => {
  it("logout・logout-all", async () => {
    const r = await h.login("google", `sub-${crypto.randomUUID()}`);
    const out = await call("POST", "/api/v1/auth/logout", { cookie: `__Host-kh_rt=${r.refreshToken}` });
    expect(cookieValue(out, "__Host-kh_invite")).toBe("");
    const r2 = await h.login("google", `sub-${crypto.randomUUID()}`);
    const all = await call("POST", "/api/v1/auth/logout-all", { token: r2.accessToken });
    expect(cookieValue(all, "__Host-kh_invite")).toBe("");
  });
});
