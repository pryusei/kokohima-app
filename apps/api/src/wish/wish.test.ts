import { env } from "cloudflare:workers";
import { friendWishGroupPageSchema, wishListSchema, wishSchema, type Wish } from "@kokohima/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html } from "../../test/fake-web";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { cleanupExpired } from "../jobs/dispatch";
import { handleJob } from "../jobs/consumer";
import { blockedReason, retryAfterSeconds } from "./domain/wish";

// 行きたい（docs/specs/T-22-wishlist.md「テスト計画」）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const place = (who: User, body: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  u.call("POST", "/api/v1/wishes", {
    token: who.token,
    body: { message: "〇〇のラーメン行きたい", area: null, url: null, excludedUserIds: [], ...body },
    headers,
  });

async function placed(who: User, body: Record<string, unknown> = {}) {
  const res = await place(who, body);
  expect(res.status).toBe(201);
  return wishSchema.parse(await res.json());
}

const mine = async (who: User) =>
  wishListSchema.parse(await (await u.call("GET", "/api/v1/wishes", { token: who.token })).json()).items;

async function everyone(viewer: User, query = "") {
  const res = await u.call("GET", `/api/v1/friend-wishes${query}`, { token: viewer.token });
  expect(res.status).toBe(200);
  return friendWishGroupPageSchema.parse(await res.json());
}

const ofFriend = (viewer: User, friendId: string) =>
  u.call("GET", `/api/v1/friends/${friendId}/wishes`, { token: viewer.token });
const getOne = (viewer: User, id: string) => u.call("GET", `/api/v1/wishes/${id}`, { token: viewer.token });
const setExcluded = (who: User, id: string, userIds: string[]) =>
  u.call("PUT", `/api/v1/wishes/${id}/exclusions`, { token: who.token, body: { userIds } });

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;

async function trio() {
  const a = await u.user("あき");
  const b = await u.user("はる");
  const c = await u.user("なつ");
  await u.befriend(a, b);
  await u.befriend(a, c);
  return { a, b, c };
}

describe("domain", () => {
  it("判定の順番は、見せない相手 → 件数 → 回数。Retry-After は、いちばん古い記録が24時間を過ぎるまで（切り上げ）", () => {
    const now = 10 * DAY;
    expect(blockedReason({ exclusionsValid: false, activeCount: 10, postsInWindow: 20, oldestPostAt: now }, now)).toEqual({ kind: "not_found" });
    expect(blockedReason({ exclusionsValid: true, activeCount: 10, postsInWindow: 20, oldestPostAt: now }, now)).toEqual({ kind: "too_many" });
    expect(blockedReason({ exclusionsValid: true, activeCount: 9, postsInWindow: 20, oldestPostAt: now - HOUR }, now)).toEqual({
      kind: "rate_limited",
      retryAfterSeconds: 23 * 60 * 60,
    });
    expect(blockedReason({ exclusionsValid: true, activeCount: 9, postsInWindow: 19, oldestPostAt: now }, now)).toBeNull();
    expect(retryAfterSeconds(now - DAY + 1500, now)).toBe(2);
    expect(retryAfterSeconds(now - DAY, now)).toBe(1);
  });
});

describe("置く・見る・消す", () => {
  it("置くと、自分の一覧・友達の「みんな」・友達の詳細に出る。消すとどこにも出ない", async () => {
    const { a, b } = await trio();
    const res = await place(a, { area: "渋谷", url: "https://example.com/ramen" });
    expect(res.status).toBe(201);
    const w = wishSchema.parse(await res.json());
    expect(res.headers.get("Location")).toBe(`/api/v1/wishes/${w.id}`);
    expect(w).toMatchObject({ owner: { id: a.id, displayName: "あき" }, message: "〇〇のラーメン行きたい", area: "渋谷", excludedUsers: [] });
    expect(w.linkPreview?.status).toBe("pending");

    expect((await mine(a)).map((x) => x.id)).toEqual([w.id]);
    const page = await everyone(b);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.friend.id).toBe(a.id);
    expect(page.items[0]?.wishes.map((x) => x.id)).toEqual([w.id]);
    // 友達には見せない相手を返さない
    expect(page.items[0]?.wishes[0]?.excludedUsers).toBeNull();
    const detail = wishListSchema.parse(await (await ofFriend(b, a.id)).json());
    expect(detail.items.map((x) => x.id)).toEqual([w.id]);
    expect(wishSchema.parse(await (await getOne(b, w.id)).json()).excludedUsers).toBeNull();

    expect((await u.call("DELETE", `/api/v1/wishes/${w.id}`, { token: a.token })).status).toBe(204);
    expect(await mine(a)).toEqual([]);
    expect((await everyone(b)).items).toEqual([]);
    expect((await getOne(b, w.id)).status).toBe(404);
    // 置いた記録は残す
    expect(await count("wish_posts WHERE user_id = ?1", a.id)).toBe(1);
  });

  it("置いても通知のイベントは書かない。リンクがあるときだけ LinkAttached を書き、payload に URL がない", async () => {
    const { a } = await trio();
    const plain = await placed(a);
    const linked = await placed(a, { url: "https://example.com/x" });
    const { results } = await env.DB.prepare("SELECT type, payload FROM outbox WHERE json_extract(payload, '$.subjectId') IN (?1, ?2)")
      .bind(plain.id, linked.id)
      .all<{ type: string; payload: string }>();
    expect(results.map((r) => r.type)).toEqual(["LinkAttached"]);
    const payload = JSON.parse(results[0]!.payload);
    expect(payload).toMatchObject({ subjectType: "wish", subjectId: linked.id });
    expect(JSON.stringify(payload)).not.toContain("example.com");
    expect(plain.linkPreview).toBeNull();
  });

  it("並び順：自分の一覧と友達の詳細は新しい順", async () => {
    const { a, b } = await trio();
    const first = await placed(a, { message: "1つめ" });
    h.clock.now += MIN;
    const second = await placed(a, { message: "2つめ" });
    expect((await mine(a)).map((x) => x.id)).toEqual([second.id, first.id]);
    expect(wishListSchema.parse(await (await ofFriend(b, a.id)).json()).items.map((x) => x.id)).toEqual([second.id, first.id]);
  });
});

describe("入力の検証", () => {
  it("ひとことの必須・100文字・改行5つ・見えない文字、エリア30文字、URL の形、見せない相手の重複・101人・UUID でない値は400", async () => {
    const a = await u.user();
    const bad = [
      { message: "" },
      { message: "   " },
      { message: null },
      { message: "あ".repeat(101) },
      { message: "1\n2\n3\n4\n5\n6\n7" },
      { message: "見えない​文字" },
      { area: "あ".repeat(31) },
      { url: "javascript:alert(1)" },
      { url: "https://user:pass@example.com/" },
      { excludedUserIds: [crypto.randomUUID(), "x"] },
      { excludedUserIds: Array.from({ length: 2 }, () => "2b8f6a1e-0000-4000-8000-000000000000") },
      { excludedUserIds: Array.from({ length: 101 }, () => crypto.randomUUID()) },
      { extra: 1 },
    ];
    for (const body of bad) {
      const res = await place(a, body);
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    // excludedUserIds は必須
    expect((await u.call("POST", "/api/v1/wishes", { token: a.token, body: { message: "a" } })).status).toBe(400);
    // area・url は省略すると null
    const res = await u.call("POST", "/api/v1/wishes", { token: a.token, body: { message: "a", excludedUserIds: [] } });
    expect(res.status).toBe(201);
    expect(wishSchema.parse(await res.json())).toMatchObject({ area: null, url: null });
    expect(await count("wishes WHERE owner_id = ?1", a.id)).toBe(1);
  });

  it("見せない相手に友達でない人・自分・片方向の行しかない人を入れると404で、何も書かれない", async () => {
    const { a, b } = await trio();
    const stranger = await u.user();
    const oneWay = await u.user();
    await env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)").bind(a.id, oneWay.id, h.clock.now).run();
    for (const ids of [[stranger.id], [a.id], [b.id, stranger.id], [oneWay.id], [crypto.randomUUID()]]) {
      expect((await place(a, { excludedUserIds: ids })).status).toBe(404);
    }
    expect(await count("wishes WHERE owner_id = ?1", a.id)).toBe(0);
    expect(await count("wish_posts WHERE user_id = ?1", a.id)).toBe(0);
  });
});

describe("上限", () => {
  it("10件目までは置け、11件目は409。1件消すとまた置ける", async () => {
    const a = await u.user();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push((await placed(a, { message: `行きたい${i}` })).id);
    const res = await place(a);
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "invalid_state" });
    expect((await u.call("DELETE", `/api/v1/wishes/${ids[0]}`, { token: a.token })).status).toBe(204);
    expect((await place(a)).status).toBe(201);
  });

  it("24時間に20回まで。置く→消すをくり返しても数え、21回目は429と Retry-After。24時間を過ぎた記録は数えない", async () => {
    const a = await u.user();
    const start = h.clock.now;
    for (let i = 0; i < 20; i++) {
      const w = await placed(a);
      expect((await u.call("DELETE", `/api/v1/wishes/${w.id}`, { token: a.token })).status).toBe(204);
      await u.advance(MIN, a);
    }
    const res = await place(a);
    expect(res.status).toBe(429);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "rate_limited" });
    // いちばん古い記録（start）が24時間を過ぎるまで
    expect(res.headers.get("Retry-After")).toBe(String(Math.ceil((start + DAY - h.clock.now) / 1000)));
    expect(await count("wishes WHERE owner_id = ?1", a.id)).toBe(0);
    await u.advance(start + DAY - h.clock.now, a);
    expect((await place(a)).status).toBe(201);
  });

  it("同時に置いても上限を超えない", async () => {
    const a = await u.user();
    for (let i = 0; i < 9; i++) await placed(a);
    const results = await Promise.all([place(a), place(a), place(a)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(await count("wishes WHERE owner_id = ?1", a.id)).toBe(10);
  });

  it("Idempotency-Key：同じキーで同じ答えが返り、2件にならない", async () => {
    const a = await u.user();
    const key = crypto.randomUUID();
    const first = await place(a, {}, { "Idempotency-Key": key });
    const again = await place(a, {}, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(((await again.json()) as Wish).id).toBe(((await first.json()) as Wish).id);
    expect(await count("wishes WHERE owner_id = ?1", a.id)).toBe(1);
  });
});

describe("見せない相手", () => {
  it("外した人からは、置いていないのと同じに見える（一覧・友達の詳細・1件）。外していない人には見える", async () => {
    const { a, b, c } = await trio();
    const w = await placed(a, { excludedUserIds: [c.id] });
    expect(w.excludedUsers?.map((p) => p.id)).toEqual([c.id]);
    expect((await everyone(b)).items).toHaveLength(1);

    // 外された c と、何も置いていない友達の応答が同じ
    const nothing = await u.user();
    await u.befriend(nothing, c);
    expect(await everyone(c)).toEqual({ items: [], nextCursor: null });
    const forC = await ofFriend(c, a.id);
    const forNothing = await ofFriend(c, nothing.id);
    expect(forC.status).toBe(200);
    expect(await forC.json()).toEqual(await forNothing.json());
    // 1件の取得は、存在しない ID と同じ404（本文の形も同じ）
    const hidden = await getOne(c, w.id);
    const missing = await getOne(c, crypto.randomUUID());
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    const strip = (v: Record<string, unknown>) => ({ ...v, requestId: null });
    expect(strip(await hidden.json())).toEqual(strip(await missing.json()));
  });

  it("あとで変えられる：外すと消え、戻すとまた見える。置く回数には数えない", async () => {
    const { a, b } = await trio();
    const w = await placed(a);
    const res = await setExcluded(a, w.id, [b.id]);
    expect(res.status).toBe(200);
    expect(wishSchema.parse(await res.json()).excludedUsers?.map((p) => p.id)).toEqual([b.id]);
    expect((await everyone(b)).items).toEqual([]);
    expect((await setExcluded(a, w.id, [])).status).toBe(200);
    expect((await everyone(b)).items).toHaveLength(1);
    expect(await count("wish_posts WHERE user_id = ?1", a.id)).toBe(1);
  });

  it("他人の行きたいの PUT・DELETE は404で、表の行は変わらない。友達でない人を入れた PUT も404で何も変わらない", async () => {
    const { a, b, c } = await trio();
    const stranger = await u.user();
    const w = await placed(a, { excludedUserIds: [c.id] });
    expect((await setExcluded(b, w.id, [])).status).toBe(404);
    expect((await u.call("DELETE", `/api/v1/wishes/${w.id}`, { token: b.token })).status).toBe(404);
    expect((await setExcluded(a, w.id, [stranger.id])).status).toBe(404);
    expect((await setExcluded(a, w.id, [a.id])).status).toBe(404);
    expect((await setExcluded(a, crypto.randomUUID(), [])).status).toBe(404);
    expect(await count("wishes WHERE id = ?1", w.id)).toBe(1);
    expect(await count("wish_exclusions WHERE wish_id = ?1 AND user_id = ?2", w.id, c.id)).toBe(1);
    expect(await count("wish_exclusions WHERE wish_id = ?1", w.id)).toBe(1);
  });

  it("あとから友達になった人に見える。外したあとに友達を解除して戻っても、PUT をはさんでも、外したまま", async () => {
    const { a, b, c } = await trio();
    const w = await placed(a, { excludedUserIds: [c.id] });
    const later = await u.user();
    await u.befriend(a, later);
    expect((await everyone(later)).items).toHaveLength(1);

    expect((await u.call("DELETE", `/api/v1/friends/${a.id}`, { token: c.token })).status).toBe(204);
    // 友達でなくなった人は、置いた人の一覧に出ない
    expect((await mine(a))[0]?.excludedUsers).toEqual([]);
    // 別の人を外す PUT をはさむ
    expect((await setExcluded(a, w.id, [b.id])).status).toBe(200);
    await u.befriend(a, c);
    expect((await everyone(c)).items).toEqual([]);
    expect((await mine(a))[0]?.excludedUsers?.map((p) => p.id).sort()).toEqual([b.id, c.id].sort());
  });

  it("片方向の友達の行しかない相手の除外の行は、PUT で消えない", async () => {
    const { a, b, c } = await trio();
    const w = await placed(a, { excludedUserIds: [c.id] });
    // c 側の行だけを消す（解除の途中の状態）
    await env.DB.prepare("DELETE FROM friendships WHERE user_id = ?1 AND friend_id = ?2").bind(c.id, a.id).run();
    expect((await setExcluded(a, w.id, [b.id])).status).toBe(200);
    expect(await count("wish_exclusions WHERE wish_id = ?1 AND user_id = ?2", w.id, c.id)).toBe(1);
  });

  it("ここ暇の「見せない」とは切り離す：暇を見せないにしても、行きたいは見える", async () => {
    const { a, b } = await trio();
    await placed(a);
    const res = await u.call("PATCH", `/api/v1/friends/${b.id}`, { token: a.token, body: { sharesMyAvailability: false } });
    expect(res.status).toBe(200);
    expect((await everyone(b)).items).toHaveLength(1);
  });
});

describe("他人のIDでは取得・更新できない", () => {
  it("友達でない人・片方向の行しかない人は、友達の詳細が存在しない ID と同じ404。1件の取得も404", async () => {
    const { a } = await trio();
    const w = await placed(a);
    const stranger = await u.user();
    const oneWay = await u.user();
    await env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)").bind(oneWay.id, a.id, h.clock.now).run();
    for (const viewer of [stranger, oneWay]) {
      const res = await ofFriend(viewer, a.id);
      const missing = await ofFriend(viewer, crypto.randomUUID());
      expect(res.status).toBe(404);
      expect(missing.status).toBe(404);
      expect((await res.json()) as { code: string }).toMatchObject({ code: "not_found" });
      expect((await getOne(viewer, w.id)).status).toBe(404);
      expect((await everyone(viewer)).items).toEqual([]);
    }
    expect((await ofFriend(stranger, "not-a-uuid")).status).toBe(404);
    expect((await getOne(stranger, "not-a-uuid")).status).toBe(404);
  });

  it("自分の一覧に他人の行きたいが混じらない。経路は友達の詳細・ここ暇とぶつからない", async () => {
    const { a, b } = await trio();
    await placed(a);
    expect(await mine(b)).toEqual([]);
    expect((await u.call("GET", `/api/v1/friends/${a.id}`, { token: b.token })).status).toBe(200);
    const range = `from=${new Date(h.clock.now).toISOString()}&to=${new Date(h.clock.now + DAY).toISOString()}`;
    expect((await u.call("GET", `/api/v1/friends/${a.id}/availabilities?${range}`, { token: b.token })).status).toBe(200);
  });

  it("認証がなければ401", async () => {
    for (const [method, path] of [
      ["GET", "/api/v1/wishes"],
      ["POST", "/api/v1/wishes"],
      ["GET", "/api/v1/friend-wishes"],
      ["GET", `/api/v1/friends/${crypto.randomUUID()}/wishes`],
    ] as const) {
      expect((await u.call(method, path)).status).toBe(401);
    }
  });
});

describe("みんな（friend-wishes）", () => {
  it("友達の並びは友達の一覧と同じ（友達になった日時の新しい順）。外された新しい行きたいがあっても順番は変わらない。カーソルで重ならずに続きが読める", async () => {
    const viewer = await u.user("みる");
    const friends: User[] = [];
    for (let i = 0; i < 3; i++) {
      const f = await u.user(`友達${i}`);
      await u.befriend(viewer, f);
      friends.push(f);
      h.clock.now += MIN;
    }
    // 友達1は何も置かない。友達0には、見られる古い行きたいと、外された新しい行きたい
    await placed(friends[0]!, { message: "古い" });
    h.clock.now += MIN;
    await placed(friends[2]!, { message: "2" });
    h.clock.now += MIN;
    await placed(friends[0]!, { message: "外された", excludedUserIds: [viewer.id] });

    const first = await everyone(viewer, "?limit=1");
    expect(first.items.map((g) => g.friend.id)).toEqual([friends[2]!.id]);
    expect(first.nextCursor).not.toBeNull();
    const second = await everyone(viewer, `?limit=1&cursor=${first.nextCursor}`);
    expect(second.items.map((g) => g.friend.id)).toEqual([friends[0]!.id]);
    expect(second.items[0]?.wishes.map((w) => w.message)).toEqual(["古い"]);
    expect(second.nextCursor).toBeNull();
    expect((await u.call("GET", "/api/v1/friend-wishes?cursor=broken", { token: viewer.token })).status).toBe(400);
    expect((await u.call("GET", "/api/v1/friend-wishes?limit=51", { token: viewer.token })).status).toBe(400);
  });

  it("回数の上限（利用者 ID ごと）を超えると429", async () => {
    const a = await u.user();
    h.limiter.allow = (limiter) => limiter !== "RL_USER";
    const res = await u.call("GET", "/api/v1/friend-wishes", { token: a.token });
    expect(res.status).toBe(429);
    expect(h.limiter.calls.at(-1)).toEqual({ limiter: "RL_USER", key: `friend_wishes:${a.id}` });
  });
});

describe("リンクのプレビュー（T-08）", () => {
  it("LinkAttached を処理すると、行きたいにカードが付く。消すと参照も消える", async () => {
    const { a, b } = await trio();
    const url = `https://wish-${crypto.randomUUID().slice(0, 8)}.example.com/`;
    h.web.page(url, () => html(`<meta property="og:title" content="行きたいのページ"><meta property="og:site_name" content="サイト">`));
    const w = await placed(a, { url });
    const { results } = await env.DB.prepare(
      "SELECT id, payload, created_at FROM outbox WHERE type = 'LinkAttached' AND json_extract(payload, '$.subjectId') = ?1",
    )
      .bind(w.id)
      .all<{
      id: string;
      payload: string;
      created_at: number;
    }>();
    for (const e of results) {
      await handleJob(h.ctx, { kind: "outbox", id: e.id, type: "LinkAttached", payload: e.payload, createdAt: e.created_at });
    }
    const seen = wishSchema.parse(await (await getOne(b, w.id)).json());
    expect(seen.linkPreview).toMatchObject({ status: "ok", title: "行きたいのページ", siteName: "サイト" });
    expect(await count("link_preview_refs WHERE wish_id = ?1", w.id)).toBe(1);
    expect((await u.call("DELETE", `/api/v1/wishes/${w.id}`, { token: a.token })).status).toBe(204);
    expect(await count("link_preview_refs WHERE wish_id = ?1", w.id)).toBe(0);
  });

  it("処理の前に消された行きたいには、参照を作らない", async () => {
    const { a } = await trio();
    const w = await placed(a, { url: "https://gone.example.com/" });
    expect((await u.call("DELETE", `/api/v1/wishes/${w.id}`, { token: a.token })).status).toBe(204);
    const e = await env.DB.prepare(
      "SELECT id, payload, created_at FROM outbox WHERE type = 'LinkAttached' AND json_extract(payload, '$.subjectId') = ?1",
    )
      .bind(w.id)
      .first<{
      id: string;
      payload: string;
      created_at: number;
    }>();
    await handleJob(h.ctx, { kind: "outbox", id: e!.id, type: "LinkAttached", payload: e!.payload, createdAt: e!.created_at });
    expect(await count("link_preview_refs WHERE wish_id = ?1", w.id)).toBe(0);
  });
});

describe("退会（T-16）と掃除（T-17）", () => {
  it("退会すると、本人の行きたい・本人が見せない相手になっている行・置いた記録がすぐに消える。書き込みは401、1件の取得は404", async () => {
    const { a, b, c } = await trio();
    const wa = await placed(a);
    const wc = await placed(c, { excludedUserIds: [a.id] });
    const withdraw = await u.call("POST", "/api/v1/me/withdrawal", {
      token: a.token,
      body: { confirm: "withdraw" },
      cookie: `__Host-kh_rt=${a.refreshToken}`,
    });
    expect(withdraw.status).toBe(204);
    expect(await count("wishes WHERE owner_id = ?1", a.id)).toBe(0);
    expect(await count("wish_exclusions WHERE user_id = ?1", a.id)).toBe(0);
    expect(await count("wish_posts WHERE user_id = ?1", a.id)).toBe(0);
    expect(await count("wishes WHERE id = ?1", wc.id)).toBe(1);
    expect((await getOne(b, wa.id)).status).toBe(404);
    // 残ったアクセストークン
    expect((await place(a)).status).toBe(401);
    expect((await getOne(a, wc.id)).status).toBe(404);
  });

  it("2日を過ぎた置いた記録は掃除で消え、行きたいは消えない", async () => {
    const a = await u.user();
    const w = await placed(a);
    h.clock.now += 2 * DAY;
    await cleanupExpired(h.ctx);
    expect(await count("wish_posts WHERE user_id = ?1", a.id)).toBe(1);
    h.clock.now += 1;
    await cleanupExpired(h.ctx);
    expect(await count("wish_posts WHERE user_id = ?1", a.id)).toBe(0);
    expect(await count("wishes WHERE id = ?1", w.id)).toBe(1);
  });
});

describe("ログ", () => {
  it("ひとこと・エリア・リンク・見せない相手の ID をログに出さない", async () => {
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(" "));
      });
    }
    const { a, c } = await trio();
    await placed(a, { message: "秘密のひとこと", area: "秘密の街", url: "https://secret.example.com/", excludedUserIds: [c.id] });
    h.limiter.allow = () => false;
    await u.call("GET", "/api/v1/friend-wishes", { token: a.token });
    const all = logs.join("\n");
    for (const s of ["秘密のひとこと", "秘密の街", "secret.example.com", c.id]) expect(all).not.toContain(s);
  });
});
