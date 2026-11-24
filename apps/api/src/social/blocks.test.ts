import { env } from "cloudflare:workers";
import { blockedUserPageSchema, friendPageSchema, safetyStartAt } from "@kokohima/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { defaultDeps } from "../app";

// ブロック（docs/specs/T-33-block-report.md「テスト計画」）。時計は 2026-10-10T00:00:00Z。始める日は、ほかのテストでは 0 にする
let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness({ safetyStartAt: 0 });
  u = makeUsers(h);
});

const T = (s: string) => `2026-10-10T${s}:00.000Z`;

async function pair() {
  const a = await u.user("あき");
  const b = await u.user("びー");
  await u.befriend(a, b);
  return { a, b };
}

const block = (who: User, body: unknown) => u.call("POST", "/api/v1/blocks", { token: who.token, body });
const unblock = (who: User, id: string) => u.call("DELETE", `/api/v1/blocks/${id}`, { token: who.token });
const listBlocks = async (who: User) => {
  const res = await u.call("GET", "/api/v1/blocks", { token: who.token });
  expect(res.status).toBe(200);
  return blockedUserPageSchema.parse(await res.json());
};
const friendsOf = async (who: User) =>
  friendPageSchema.parse(await (await u.call("GET", "/api/v1/friends", { token: who.token })).json()).items.map((f) => f.id);

async function newLink(owner: User) {
  const res = await u.call("POST", "/api/v1/invite-links", { token: owner.token, body: {} });
  expect(res.status).toBe(201);
  const link = (await res.json()) as { id: string; url: string };
  return { id: link.id, token: decodeURIComponent(link.url.split("#t=")[1] ?? "") };
}
const lookup = (token: string, viewer?: User) =>
  u.call("POST", "/api/v1/invite-links/lookup", { token: viewer?.token, body: { token } });
const accept = (viewer: User, link: { id: string; token: string }) =>
  u.call("POST", "/api/v1/invite-links/accept", {
    token: viewer.token,
    body: { linkId: link.id },
    cookie: `__Host-kh_invite=${link.token}`,
  });

async function invite(from: User, to: User) {
  const res = await u.call("POST", "/api/v1/direct-invites", {
    token: from.token,
    body: { recipientId: to.id, startsAt: T("11:00"), endsAt: T("13:00"), message: "あそぼ" },
  });
  return res;
}

describe("ブロックする（POST /blocks）", () => {
  it("友達をブロックすると204。両方向の友達の行と「見せる」の公開設定が消え、outbox に何も書かれない", async () => {
    const { a, b } = await pair();
    expect((await u.call("PATCH", `/api/v1/friends/${b.id}`, { token: a.token, body: { sharesMyAvailability: true } })).status).toBe(200);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>();
    const res = await block(a, { userId: b.id });
    expect(res.status).toBe(204);
    expect(await friendsOf(a)).not.toContain(b.id);
    expect(await friendsOf(b)).not.toContain(a.id);
    const sharing = await env.DB.prepare("SELECT COUNT(*) AS n FROM sharing_policies WHERE owner_id = ?1 AND target_id = ?2")
      .bind(a.id, b.id)
      .first<{ n: number }>();
    expect(sharing?.n).toBe(0);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("ブロックされた側から見ると、解除と同じ（友達の詳細は同じ404、一覧から消える）", async () => {
    const { a, b } = await pair();
    const c = await u.user("しー");
    const d = await u.user("でぃー");
    await u.befriend(c, d);
    await block(a, { userId: b.id });
    expect((await u.call("DELETE", `/api/v1/friends/${c.id}`, { token: d.token })).status).toBe(204);
    const blocked = await u.call("GET", `/api/v1/friends/${a.id}`, { token: b.token });
    const unfriended = await u.call("GET", `/api/v1/friends/${c.id}`, { token: d.token });
    expect(blocked.status).toBe(404);
    expect(unfriended.status).toBe(404);
    const strip = (body: Record<string, unknown>) => ({ ...body, requestId: undefined, instance: undefined });
    expect(strip((await blocked.json()) as Record<string, unknown>)).toEqual(strip((await unfriended.json()) as Record<string, unknown>));
  });

  it("何度送っても204で、ブロックした時刻は最初のまま", async () => {
    const { a, b } = await pair();
    expect((await block(a, { userId: b.id })).status).toBe(204);
    const first = (await listBlocks(a)).items[0]?.blockedAt;
    h.clock.now += 60_000;
    expect((await block(a, { userId: b.id })).status).toBe(204);
    expect((await listBlocks(a)).items.map((i) => i.blockedAt)).toEqual([first]);
  });

  it("友達でなくなった人も、届いた誘いからならブロックできる。送った側の誘いや関係のない誘いでは404", async () => {
    const { a, b } = await pair();
    const res = await invite(b, a);
    expect(res.status).toBe(201);
    const inv = (await res.json()) as { id: string };
    // b が先に解除しても、a は届いた誘いからブロックできる
    expect((await u.call("DELETE", `/api/v1/friends/${a.id}`, { token: b.token })).status).toBe(204);
    expect((await block(a, { userId: b.id })).status).toBe(404);
    expect((await block(a, { userId: b.id, subject: { type: "direct_invite", id: inv.id } })).status).toBe(204);
    // 送った側（b）からは、自分の送った誘いを対象にできない
    const c = await u.user("しー");
    expect((await block(b, { userId: a.id, subject: { type: "direct_invite", id: inv.id } })).status).toBe(404);
    // 対象の送り主と userId が違えば404
    expect((await block(a, { userId: c.id, subject: { type: "direct_invite", id: inv.id } })).status).toBe(404);
  });

  it("届いた募集からブロックできる", async () => {
    const { a, b } = await pair();
    const c = await u.user("しー");
    await u.befriend(b, c);
    const res = await u.call("POST", "/api/v1/broadcasts", {
      token: b.token,
      body: { recipientIds: [a.id, c.id], startsAt: T("11:00"), endsAt: T("13:00") },
    });
    expect(res.status).toBe(201);
    const bc = (await res.json()) as { id: string };
    expect((await block(a, { userId: b.id, subject: { type: "broadcast", id: bc.id } })).status).toBe(204);
    expect(await friendsOf(a)).not.toContain(b.id);
  });

  it("他人の ID では操作できない：友達でない・存在しない・自分は同じ404で、行ができない", async () => {
    const { a } = await pair();
    const stranger = await u.user("しらない");
    for (const userId of [stranger.id, crypto.randomUUID(), a.id]) {
      const res = await block(a, { userId });
      expect(res.status).toBe(404);
      expect(((await res.json()) as { code: string }).code).toBe("not_found");
    }
    expect((await listBlocks(a)).items).toHaveLength(0);
  });

  it("入力検証：知らない項目・ID でないは400", async () => {
    const { a, b } = await pair();
    for (const body of [{ userId: "x" }, { userId: b.id, blockerId: a.id }, {}]) {
      expect((await block(a, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("認証がなければ401", async () => {
    expect((await u.call("POST", "/api/v1/blocks", { body: { userId: crypto.randomUUID() } })).status).toBe(401);
    expect((await u.call("GET", "/api/v1/blocks")).status).toBe(401);
    expect((await u.call("DELETE", `/api/v1/blocks/${crypto.randomUUID()}`)).status).toBe(401);
  });
});

describe("ブロックしている間", () => {
  it("どちらの向きの招待リンクでも友達にならず、lookup は使えないリンクと同じ404", async () => {
    const { a, b } = await pair();
    await block(a, { userId: b.id });
    const aLink = await newLink(a);
    const bLink = await newLink(b);
    const revoked = await newLink(a);
    expect((await u.call("POST", `/api/v1/invite-links/${revoked.id}/revoke`, { token: a.token })).status).toBe(204);

    // ログインした b が a のリンクを、a が b のリンクを開く
    const blockedLookup = await lookup(aLink.token, b);
    const revokedLookup = await lookup(revoked.token, b);
    expect(blockedLookup.status).toBe(404);
    expect((await lookup(bLink.token, a)).status).toBe(404);
    // 取り消したリンクと同じ形（Cookie も同じく消す）
    expect(blockedLookup.headers.get("Set-Cookie")).toEqual(revokedLookup.headers.get("Set-Cookie"));
    const strip = (body: Record<string, unknown>) => ({ ...body, requestId: undefined, instance: undefined });
    expect(strip((await blockedLookup.json()) as Record<string, unknown>)).toEqual(strip((await revokedLookup.json()) as Record<string, unknown>));

    // 未ログインなら発行者が出るが、accept は404で友達にならず、人数も消費しない
    expect((await lookup(aLink.token)).status).toBe(200);
    expect((await accept(b, aLink)).status).toBe(404);
    expect((await accept(a, bLink)).status).toBe(404);
    expect(await friendsOf(a)).not.toContain(b.id);
    const uses = await env.DB.prepare("SELECT uses FROM invite_links WHERE id = ?").bind(aLink.id).first<{ uses: number }>();
    expect(uses?.uses).toBe(0);
  });

  it("新しい誘い・募集の宛先にならない（友達でないので404・400）", async () => {
    const { a, b } = await pair();
    await block(a, { userId: b.id });
    expect((await invite(b, a)).status).toBe(404);
    expect((await invite(a, b)).status).toBe(404);
    const bc = await u.call("POST", "/api/v1/broadcasts", {
      token: b.token,
      body: { recipientIds: [a.id], startsAt: T("11:00"), endsAt: T("13:00") },
    });
    expect(bc.status).not.toBe(201);
  });

  it("ほかの人は、同じ発行者のリンクで今までどおり友達になれる", async () => {
    const { a, b } = await pair();
    await block(a, { userId: b.id });
    const c = await u.user("しー");
    const link = await newLink(a);
    expect((await lookup(link.token, c)).status).toBe(200);
    expect((await accept(c, link)).status).toBe(201);
  });
});

describe("ブロックの一覧とやめる（GET /blocks・DELETE /blocks/{userId}）", () => {
  it("閲覧者がブロックした人だけを、新しい順で返す。ブロックされた側の一覧には出ない", async () => {
    const a = await u.user("あき");
    const b = await u.user("びー");
    const c = await u.user("しー");
    await u.befriend(a, b);
    await u.befriend(a, c);
    await block(a, { userId: b.id });
    h.clock.now += 1000;
    await block(a, { userId: c.id });
    const page = await listBlocks(a);
    expect(page.items.map((i) => i.user.id)).toEqual([c.id, b.id]);
    expect(page.items[0]?.user).toEqual({ id: c.id, displayName: "しー", avatarUrl: null, withdrawn: false });
    expect((await listBlocks(b)).items).toHaveLength(0);
  });

  it("カーソルで続きを取れる。壊れたカーソルは400", async () => {
    const a = await u.user("あき");
    const others = [await u.user("1"), await u.user("2"), await u.user("3")];
    for (const o of others) {
      await u.befriend(a, o);
      await block(a, { userId: o.id });
      h.clock.now += 1000;
    }
    const first = blockedUserPageSchema.parse(await (await u.call("GET", "/api/v1/blocks?limit=2", { token: a.token })).json());
    expect(first.items).toHaveLength(2);
    const next = blockedUserPageSchema.parse(
      await (await u.call("GET", `/api/v1/blocks?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, { token: a.token })).json(),
    );
    expect(next.items.map((i) => i.user.id)).toEqual([others[0]?.id]);
    expect(next.nextCursor).toBeNull();
    expect((await u.call("GET", "/api/v1/blocks?cursor=xx", { token: a.token })).status).toBe(400);
  });

  it("やめると204で、友達には戻らない。招待リンクでつながり直せる", async () => {
    const { a, b } = await pair();
    await block(a, { userId: b.id });
    expect((await unblock(a, b.id)).status).toBe(204);
    expect(await friendsOf(a)).not.toContain(b.id);
    const link = await newLink(a);
    expect((await lookup(link.token, b)).status).toBe(200);
    expect((await accept(b, link)).status).toBe(201);
  });

  it("他人の ID では操作できない：ブロックされた側・関係のない人はやめられず、同じ404", async () => {
    const { a, b } = await pair();
    const c = await u.user("しー");
    await block(a, { userId: b.id });
    expect((await unblock(b, a.id)).status).toBe(404);
    expect((await unblock(c, b.id)).status).toBe(404);
    expect((await unblock(a, crypto.randomUUID())).status).toBe(404);
    expect((await unblock(a, "x")).status).toBe(404);
    expect((await listBlocks(a)).items).toHaveLength(1);
  });
});

describe("退会", () => {
  it("どちらかが退会すると、両方向のブロックの行が消える", async () => {
    const { a, b } = await pair();
    await block(a, { userId: b.id });
    const { withdrawalPurgeStatements } = await import("./application/social");
    await env.DB.batch(withdrawalPurgeStatements(env.DB, b.id));
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM blocks WHERE blocker_id = ?1 OR blocked_id = ?1").bind(b.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("始める日（「振る舞い 8.」）", () => {
  it("始める日より前は、認証より前に知らない経路と同じ404。行はできない", async () => {
    const { a, b } = await pair();
    const start = h.clock.now + 1;
    const closed = await createHarness({ safetyStartAt: start });
    const res = await closed.request("/api/v1/blocks", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ userId: b.id }),
    });
    expect(res.status).toBe(404);
    expect((await closed.request("/api/v1/blocks")).status).toBe(404);
    expect((await (await createHarness({ safetyStartAt: null })).request("/api/v1/blocks")).status).toBe(404);
    expect((await listBlocks(a)).items).toHaveLength(0);
  });

  it("既定の始める日は packages/shared の safetyStartAt()（safetyStart.json）", () => {
    expect(defaultDeps().safetyStartAt).toBe(safetyStartAt());
  });
});
