import { env } from "cloudflare:workers";
import { broadcastPageSchema, broadcastSchema, meetupPageSchema, meetupSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { HOUR_MS } from "./domain/directInvite";

// 時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）
let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const iso = (ms: number) => new Date(ms).toISOString();
const T = (s: string) => `2026-10-10T${s}:00.000Z`;

/** 募集者 A と、A の友達 n 人 */
async function group(n: number) {
  const owner = await u.user("あき");
  const friends: User[] = [];
  for (let i = 0; i < n; i++) {
    const f = await u.user(`友${i}`);
    await u.befriend(owner, f);
    friends.push(f);
  }
  return { owner, friends };
}

function create(owner: User, recipients: (User | string)[], over: Record<string, unknown> = {}) {
  return u.call("POST", "/api/v1/broadcasts", {
    token: owner.token,
    body: {
      recipientIds: recipients.map((r) => (typeof r === "string" ? r : r.id)),
      startsAt: T("11:00"),
      endsAt: T("13:00"),
      ...over,
    },
  });
}

async function created(owner: User, recipients: User[], over: Record<string, unknown> = {}) {
  const res = await create(owner, recipients, over);
  expect(res.status).toBe(201);
  return broadcastSchema.parse(await res.json());
}

const get = (who: User, id: string) => u.call("GET", `/api/v1/broadcasts/${id}`, { token: who.token });
const respond = (who: User, id: string) => u.call("POST", `/api/v1/broadcasts/${id}/responses`, { token: who.token });
const withdraw = (who: User, id: string) => u.call("DELETE", `/api/v1/broadcasts/${id}/responses/me`, { token: who.token });
const decide = (who: User, id: string) => u.call("POST", `/api/v1/broadcasts/${id}/decide`, { token: who.token });
const leave = (who: User, id: string) => u.call("POST", `/api/v1/meetups/${id}/cancel`, { token: who.token });
const view = async (who: User, id: string) => broadcastSchema.parse(await (await get(who, id)).json());
const meetup = async (who: User, id: string) =>
  meetupSchema.parse(await (await u.call("GET", `/api/v1/meetups/${id}`, { token: who.token })).json());

/** テストの間で DB は共有されるので、関係する ID を含むイベントだけを読む */
async function outbox(type: string, id: string) {
  const { results } = await env.DB.prepare(
    "SELECT payload FROM outbox WHERE type = ? AND payload LIKE ? ORDER BY created_at, rowid",
  )
    .bind(type, `%${id}%`)
    .all<{ payload: string }>();
  return results.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

/** 本文の比較（requestId は毎回違うので除く） */
async function body(res: Response) {
  const json = (await res.json()) as Record<string, unknown>;
  return JSON.stringify({ ...json, requestId: null, status: json.status });
}

describe("作成", () => {
  it("友達に送れる。201・Location・宛先の行・宛先ごとの BroadcastSent", async () => {
    const { owner, friends } = await group(2);
    const res = await create(owner, friends, { area: "渋谷", message: "ごはん" });
    expect(res.status).toBe(201);
    const b = broadcastSchema.parse(await res.json());
    expect(res.headers.get("Location")).toBe(`/api/v1/broadcasts/${b.id}`);
    expect(b).toMatchObject({
      direction: "sent",
      status: "open",
      responseCount: 0,
      respondedByMe: null,
      meetupId: null,
      area: "渋谷",
      expiresAt: T("11:00"),
    });
    expect(b.recipients?.map((r) => r.id).sort()).toEqual(friends.map((f) => f.id).sort());
    const events = await outbox("BroadcastSent", b.id);
    expect(events.map((e) => e.userId).sort()).toEqual(friends.map((f) => f.id).sort());
    expect(events[0]).toEqual({ userId: events[0]?.userId, broadcastId: b.id, actorId: owner.id, occurredAt: T("00:00") });
  });

  it.each([
    ["宛先1人", (f: User[]) => [f[0]]],
    ["宛先の重複", (f: User[]) => [f[0], f[0]]],
  ])("入力の検証：%s は400", async (_l, pick) => {
    const { owner, friends } = await group(2);
    expect((await create(owner, pick(friends) as User[])).status).toBe(400);
  });

  it("入力の検証：101人は400、時間の規則は T-04 と同じ", async () => {
    const { owner, friends } = await group(2);
    const many = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect((await create(owner, many)).status).toBe(400);
    expect((await create(owner, friends, { startsAt: T("00:00"), endsAt: T("01:00") })).status).toBe(400);
    expect((await create(owner, friends, { url: "javascript:alert(1)" })).status).toBe(400);
  });

  it("宛先100人で作れる（宛先は JSON の配列1つで渡す）", async () => {
    const owner = await u.user();
    const now = h.clock.now;
    const ids = Array.from({ length: 100 }, () => crypto.randomUUID());
    const statements = ids.flatMap((id) => [
      env.DB.prepare("INSERT INTO users (id, display_name, created_at, updated_at) VALUES (?, 'x', ?, ?)").bind(id, now, now),
      env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)").bind(owner.id, id, now),
      env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, ?)").bind(id, owner.id, now),
    ]);
    await env.DB.batch(statements);
    const b = await created(owner, ids as unknown as User[]);
    expect(b.recipients).toHaveLength(100);
    expect(await outbox("BroadcastSent", b.id)).toHaveLength(100);
  });

  it("宛先に友達でない人・存在しない人・片方向の人・自分が1人でもいれば404で、何もできない", async () => {
    const { owner, friends } = await group(2);
    const stranger = await u.user();
    const oneWay = await u.user();
    await u.befriend(owner, oneWay);
    await env.DB.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(oneWay.id, owner.id).run();
    const bodies = new Set<string>();
    for (const extra of [stranger.id, crypto.randomUUID(), oneWay.id, owner.id]) {
      const res = await create(owner, [...friends, extra]);
      expect(res.status).toBe(404);
      bodies.add(await body(res));
    }
    expect(bodies.size).toBe(1);
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM broadcasts WHERE owner_id = ?").bind(owner.id).first<{ n: number }>();
    expect(rows?.n).toBe(0);
    expect(await outbox("BroadcastSent", owner.id)).toHaveLength(0);
  });

  it("送信上限：誘いと募集あわせて20件。両方向で429になり、Retry-After はいちばん古い送信から", async () => {
    const { owner, friends } = await group(2);
    const [b0, b1] = friends as [User, User];
    for (let i = 0; i < 10; i++) {
      const start = Date.parse(T("01:00")) + i * HOUR_MS;
      expect((await create(owner, friends, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) })).status).toBe(201);
    }
    await u.advance(60 * 60 * 1000, owner, b0, b1);
    for (let i = 0; i < 10; i++) {
      const start = Date.parse(T("12:00")) + i * HOUR_MS;
      const res = await u.call("POST", "/api/v1/direct-invites", {
        token: owner.token,
        body: { recipientId: b0.id, startsAt: iso(start), endsAt: iso(start + HOUR_MS) },
      });
      expect(res.status).toBe(201);
    }
    const invite = await u.call("POST", "/api/v1/direct-invites", {
      token: owner.token,
      body: { recipientId: b1.id, startsAt: "2026-10-12T01:00:00Z", endsAt: "2026-10-12T02:00:00Z" },
    });
    expect(invite.status).toBe(429);
    // いちばん古い送信は 00:00Z の募集。今は 01:00Z なので、24時間を過ぎるまで 23時間
    expect(invite.headers.get("Retry-After")).toBe(String(23 * 3600));
    const broadcast = await create(owner, friends, { startsAt: "2026-10-12T01:00:00Z", endsAt: "2026-10-12T02:00:00Z" });
    expect(broadcast.status).toBe(429);
    expect(broadcast.headers.get("Retry-After")).toBe(String(23 * 3600));
  });

  it("送信上限：同時に作っても20件を超えない", async () => {
    const { owner, friends } = await group(2);
    for (let i = 0; i < 18; i++) {
      const start = Date.parse(T("01:00")) + i * HOUR_MS;
      await created(owner, friends, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) });
    }
    const results = await Promise.all(
      [0, 1, 2, 3].map((i) => {
        const start = Date.parse("2026-10-12T01:00:00Z") + i * HOUR_MS;
        return create(owner, friends, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) });
      }),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
  });
});

describe("一覧と詳細", () => {
  it("募集者の sent、宛先の received、新しい順とカーソル、ほかの人の募集は出ない。宛先でない人は404", async () => {
    const { owner, friends } = await group(3);
    const [a, b, c] = friends as [User, User, User];
    const first = await created(owner, [a, b]);
    await u.advance(60 * 1000, owner, a, b, c);
    const second = await created(owner, [a, b], { startsAt: T("14:00"), endsAt: T("15:00") });
    const sent = broadcastPageSchema.parse(
      await (await u.call("GET", "/api/v1/broadcasts?box=sent&limit=1", { token: owner.token })).json(),
    );
    expect(sent.items.map((i) => i.id)).toEqual([second.id]);
    const rest = broadcastPageSchema.parse(
      await (await u.call("GET", `/api/v1/broadcasts?box=sent&limit=1&cursor=${sent.nextCursor}`, { token: owner.token })).json(),
    );
    expect(rest.items.map((i) => i.id)).toEqual([first.id]);
    const received = broadcastPageSchema.parse(
      await (await u.call("GET", "/api/v1/broadcasts?box=received", { token: a.token })).json(),
    );
    expect(received.items.map((i) => i.id)).toEqual([second.id, first.id]);
    expect(received.items[0]).toMatchObject({ direction: "received", owner: { id: owner.id }, recipients: null, responseCount: null });
    const none = broadcastPageSchema.parse(await (await u.call("GET", "/api/v1/broadcasts?box=received", { token: c.token })).json());
    expect(none.items).toHaveLength(0);
    expect((await get(c, first.id)).status).toBe(404);
    expect((await u.call("GET", "/api/v1/broadcasts", { token: a.token })).status).toBe(400);
  });
});

describe("秘匿", () => {
  it("宛先の一覧は、閲覧者が募集者の募集についてだけ返す（宛先の人の ID で読んでも空）", async () => {
    const { owner, friends } = await group(2);
    const [a] = friends as [User, User];
    const bc = await created(owner, friends);
    const { recipientsOf } = await import("./infra/broadcastRepository");
    expect((await recipientsOf(env.DB, a.id, [bc.id])).size).toBe(0);
    expect((await recipientsOf(env.DB, owner.id, [bc.id])).get(bc.id)).toHaveLength(2);
  });

  it("決める前、募集者には人数だけで名前も ID も返さない。宛先の人には人数を返さない", async () => {
    const { owner, friends } = await group(3);
    const [a, b] = friends as [User, User, User];
    const bc = await created(owner, friends);
    await respond(a, bc.id);
    await respond(b, bc.id);
    const res = await get(owner, bc.id);
    const text = await res.clone().text();
    expect(broadcastSchema.parse(await res.json()).responseCount).toBe(2);
    expect(JSON.parse(text)).toMatchObject({ respondedByMe: null });
    // 宛先の一覧（自分で選んだ相手）以外に、応じた人を示す項目がない
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(Object.keys(broadcastSchema.shape).sort());
    const fromA = await view(a, bc.id);
    expect(fromA).toMatchObject({ responseCount: null, recipients: null, respondedByMe: true });
  });

  it("参加者でない宛先の人の応答は、ほかの人が応じても・決まっても同じ（期限前と期限後）", async () => {
    const { owner, friends } = await group(4);
    const [a, b, c, d] = friends as [User, User, User, User];
    const quiet = await created(owner, [a, b], { expiresIn: "1h" });
    const decided = await created(owner, [c, d], { expiresIn: "1h" });
    await respond(c, decided.id);
    expect((await decide(owner, decided.id)).status).toBe(200);
    const shape = (x: Record<string, unknown>) => JSON.stringify({ ...x, id: null, createdAt: null, owner: null });
    // 期限前の応じる・やめるの応答も、決まった募集と決まっていない募集で同じ
    for (const op of [respond, withdraw]) {
      const rb = await op(b, quiet.id);
      const rd = await op(d, decided.id);
      expect([rb.status, rd.status]).toEqual([200, 200]);
      expect(shape((await rb.json()) as Record<string, unknown>)).toBe(shape((await rd.json()) as Record<string, unknown>));
    }
    const vb = (await get(b, quiet.id)).json() as Promise<Record<string, unknown>>;
    const vd = (await get(d, decided.id)).json() as Promise<Record<string, unknown>>;
    expect(shape(await vb)).toBe(shape(await vd));
    expect(((await vd) as { status: string }).status).toBe("open");

    await u.advance(HOUR_MS, owner, a, b, c, d);
    const eb = (await (await get(b, quiet.id)).json()) as Record<string, unknown>;
    const ed = (await (await get(d, decided.id)).json()) as Record<string, unknown>;
    expect(shape(eb)).toBe(shape(ed));
    expect(ed.status).toBe("closed");
    // 応じる・やめるのエラーも同じ本文とコード
    for (const op of [respond, withdraw]) {
      const rb = await op(b, quiet.id);
      const rd = await op(d, decided.id);
      expect(rb.status).toBe(409);
      expect(await body(rb)).toBe(await body(rd));
    }
  });
});

describe("応じる・やめる", () => {
  it("冪等。応じた時刻は最初のまま、募集者の人数が増減する。outbox に書かない。募集者・宛先でない人は404", async () => {
    const { owner, friends } = await group(3);
    const [a, , c] = friends as [User, User, User];
    const bc = await created(owner, friends.slice(0, 2));
    expect((await respond(a, bc.id)).status).toBe(200);
    const first = await env.DB.prepare("SELECT responded_at FROM broadcast_recipients WHERE broadcast_id = ? AND user_id = ?")
      .bind(bc.id, a.id)
      .first<{ responded_at: number }>();
    await u.advance(60 * 1000, owner, a, c);
    expect((await respond(a, bc.id)).status).toBe(200);
    const again = await env.DB.prepare("SELECT responded_at FROM broadcast_recipients WHERE broadcast_id = ? AND user_id = ?")
      .bind(bc.id, a.id)
      .first<{ responded_at: number }>();
    expect(again?.responded_at).toBe(first?.responded_at);
    expect((await view(owner, bc.id)).responseCount).toBe(1);
    expect((await withdraw(a, bc.id)).status).toBe(200);
    expect((await withdraw(a, bc.id)).status).toBe(200);
    expect((await view(owner, bc.id)).responseCount).toBe(0);
    expect((await view(a, bc.id)).respondedByMe).toBe(false);
    expect((await respond(owner, bc.id)).status).toBe(404);
    expect((await respond(c, bc.id)).status).toBe(404);
    expect((await withdraw(owner, bc.id)).status).toBe(404);
    expect((await withdraw(c, bc.id)).status).toBe(404);
    const { results } = await env.DB.prepare("SELECT type FROM outbox WHERE payload LIKE ? AND type <> 'BroadcastSent'")
      .bind(`%${bc.id}%`)
      .all();
    expect(results).toHaveLength(0);
  });

  it("期限後は409 expired。予定の参加者は409 invalid_state", async () => {
    const { owner, friends } = await group(2);
    const [a, b] = friends as [User, User];
    const bc = await created(owner, friends, { expiresIn: "1h" });
    await respond(a, bc.id);
    await decide(owner, bc.id);
    expect(await (await withdraw(a, bc.id)).json()).toMatchObject({ code: "invalid_state" });
    await u.advance(HOUR_MS, owner, a, b);
    expect(await (await respond(b, bc.id)).json()).toMatchObject({ code: "expired" });
  });

  it("決めた後に応じる：期限前は200で受け付け、予定には入らず、募集者の人数も変わらない。期限後は closed", async () => {
    const { owner, friends } = await group(2);
    const [a, b] = friends as [User, User];
    const bc = await created(owner, friends, { expiresIn: "1h" });
    await respond(a, bc.id);
    const decided = broadcastSchema.parse(await (await decide(owner, bc.id)).json());
    expect((await respond(b, bc.id)).status).toBe(200);
    expect(await view(b, bc.id)).toMatchObject({ status: "open", respondedByMe: true, meetupId: null });
    expect((await view(owner, bc.id)).responseCount).toBe(1);
    expect((await meetup(owner, decided.meetupId ?? "")).participants.map((p) => p.id)).toEqual([a.id]);
    await u.advance(HOUR_MS, owner, a, b);
    expect((await view(b, bc.id)).status).toBe("closed");
  });
});

describe("決める", () => {
  it("応じた人全員と募集者の予定ができ、互いの名前が見える。予定の内容は募集のもの。イベントの参加者が行と一致する", async () => {
    const { owner, friends } = await group(3);
    const [a, b, c] = friends as [User, User, User];
    const bc = await created(owner, friends, { area: "渋谷", message: "ごはん", url: "https://example.com/" });
    await respond(a, bc.id);
    await respond(b, bc.id);
    const res = await decide(owner, bc.id);
    expect(res.status).toBe(200);
    const decided = broadcastSchema.parse(await res.json());
    expect(decided).toMatchObject({ status: "decided", responseCount: 2 });
    const id = decided.meetupId ?? "";
    const fromA = await meetup(a, id);
    expect(fromA).toMatchObject({ area: "渋谷", message: "ごはん", url: "https://example.com/", broadcastId: bc.id, directInviteId: null });
    expect(fromA.participants.map((p) => p.id).sort()).toEqual([owner.id, b.id].sort());
    expect(await view(a, bc.id)).toMatchObject({ status: "decided", meetupId: id });
    expect(await view(c, bc.id)).toMatchObject({ status: "open", meetupId: null });
    // 参加者でない宛先の人と無関係の人は、予定の ID を知っても、存在しない予定と同じ404
    const stranger = await u.user();
    const missing = crypto.randomUUID();
    for (const who of [c, stranger]) {
      for (const path of [`/api/v1/meetups/${id}`, `/api/v1/meetups/${missing}`]) {
        expect((await u.call("GET", path, { token: who.token })).status).toBe(404);
      }
      const cancelled = await leave(who, id);
      expect(cancelled.status).toBe(404);
      expect(await body(cancelled)).toBe(await body(await leave(who, missing)));
    }
    expect((await decide(stranger, bc.id)).status).toBe(404);
    expect((await get(stranger, bc.id)).status).toBe(404);
    const rows = await env.DB.prepare("SELECT user_id FROM meetup_participants WHERE meetup_id = ?").bind(id).all<{ user_id: string }>();
    const expected = rows.results.map((r) => r.user_id).sort();
    expect(expected).toEqual([owner.id, a.id, b.id].sort());
    const [decidedEvent] = await outbox("BroadcastDecided", bc.id);
    const [confirmedEvent] = await outbox("MeetupConfirmed", bc.id);
    expect((decidedEvent?.participantIds as string[]).sort()).toEqual(expected);
    expect(confirmedEvent).toMatchObject({ meetupId: id, inviteId: null, broadcastId: bc.id, occurredAt: T("00:00") });
    expect((confirmedEvent?.participantIds as string[]).sort()).toEqual(expected);
  });

  it("応じた人0人・2回目は409 invalid_state、期限後は409 expired、募集者でない人は404", async () => {
    const { owner, friends } = await group(2);
    const [a, b] = friends as [User, User];
    const bc = await created(owner, friends, { expiresIn: "1h" });
    expect(await (await decide(owner, bc.id)).json()).toMatchObject({ code: "invalid_state" });
    await respond(a, bc.id);
    expect((await decide(a, bc.id)).status).toBe(404);
    expect((await decide(owner, bc.id)).status).toBe(200);
    expect(await (await decide(owner, bc.id)).json()).toMatchObject({ code: "invalid_state" });
    const late = await created(owner, friends, { expiresIn: "1h", startsAt: T("14:00"), endsAt: T("15:00") });
    await respond(b, late.id);
    await u.advance(HOUR_MS, owner, a, b);
    expect(await (await decide(owner, late.id)).json()).toMatchObject({ code: "expired" });
    // 期限切れでは、作成時の BroadcastSent のほかに何も書かない
    const { results } = await env.DB.prepare("SELECT type FROM outbox WHERE payload LIKE ? AND type <> 'BroadcastSent'")
      .bind(`%${late.id}%`)
      .all();
    expect(results).toHaveLength(0);
  });

  it("同時に決める・応じる・やめる：決定は1回だけ、予定は1つ、参加者はイベントと一致する", async () => {
    const { owner, friends } = await group(3);
    const [a, b, c] = friends as [User, User, User];
    const bc = await created(owner, friends);
    await respond(a, bc.id);
    await respond(b, bc.id);
    const results = await Promise.all([decide(owner, bc.id), decide(owner, bc.id), respond(c, bc.id), withdraw(b, bc.id)]);
    // 決めるは1回だけ成功する。応じる・やめるは決定の前か後のどちらかに入る
    expect([results[0]?.status, results[1]?.status].sort()).toEqual([200, 409]);
    const meetups = await env.DB.prepare("SELECT id FROM meetups WHERE broadcast_id = ?").bind(bc.id).all<{ id: string }>();
    expect(meetups.results).toHaveLength(1);
    const id = meetups.results[0]?.id ?? "";
    const rows = await env.DB.prepare("SELECT user_id FROM meetup_participants WHERE meetup_id = ?").bind(id).all<{ user_id: string }>();
    const [event] = await outbox("BroadcastDecided", bc.id);
    expect((event?.participantIds as string[]).sort()).toEqual(rows.results.map((r) => r.user_id).sort());
    expect(await outbox("BroadcastDecided", bc.id)).toHaveLength(1);
  });
});

describe("やっぱり難しい（募集の予定）", () => {
  async function decidedMeetup(n: number) {
    const { owner, friends } = await group(n);
    const bc = await created(owner, friends);
    for (const f of friends) await respond(f, bc.id);
    const d = broadcastSchema.parse(await (await decide(owner, bc.id)).json());
    return { owner, friends, bc, id: d.meetupId ?? "" };
  }

  it("抜けた人だけが外れ、ほかの人には残る。抜けた人には一覧に出ず詳細は cancelled、2回目は invalid_state", async () => {
    const { owner, friends, bc, id } = await decidedMeetup(2);
    const [a, b] = friends as [User, User];
    const res = await leave(a, id);
    expect(res.status).toBe(200);
    const left = meetupSchema.parse(await res.json());
    expect(left.status).toBe("cancelled");
    expect(left.participants).toEqual([]);
    const fromB = await meetup(b, id);
    expect(fromB.status).toBe("confirmed");
    expect(fromB.participants.map((p) => p.id)).toEqual([owner.id]);
    const list = meetupPageSchema.parse(await (await u.call("GET", "/api/v1/meetups", { token: a.token })).json());
    expect(list.items).toHaveLength(0);
    expect(await view(a, bc.id)).toMatchObject({ status: "decided", meetupId: id });
    expect(await (await leave(a, id)).json()).toMatchObject({ code: "invalid_state" });
    const [leftEvent] = await outbox("MeetupLeft", id);
    expect(leftEvent).toMatchObject({ meetupId: id, actorId: a.id });
    expect((leftEvent?.participantIds as string[]).sort()).toEqual([owner.id, b.id].sort());
    expect(await outbox("MeetupCancelled", id)).toHaveLength(0);
  });

  it("募集者が抜けると予定ごと取り消す", async () => {
    const { owner, friends, id } = await decidedMeetup(2);
    await leave(owner, id);
    expect((await meetup(friends[0] as User, id)).status).toBe("cancelled");
    const [cancelled] = await outbox("MeetupCancelled", id);
    expect((cancelled?.participantIds as string[]).sort()).toEqual([owner.id, ...friends.map((f) => f.id)].sort());
    expect(await outbox("MeetupLeft", id)).toHaveLength(0);
  });

  it("応じた人1人の2人の予定で、応じた人が抜けると予定ごと取り消す", async () => {
    const { owner, friends } = await group(2);
    const [a] = friends as [User, User];
    const bc = await created(owner, friends);
    await respond(a, bc.id);
    const id = broadcastSchema.parse(await (await decide(owner, bc.id)).json()).meetupId ?? "";
    await leave(a, id);
    expect((await meetup(owner, id)).status).toBe("cancelled");
  });

  it("同時に2人が抜けても、残り1人になった時点で予定ごと取り消す", async () => {
    const { owner, friends, id } = await decidedMeetup(2);
    const [a, b] = friends as [User, User];
    const results = await Promise.all([leave(a, id), leave(b, id)]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect((await meetup(owner, id)).status).toBe("cancelled");
    expect(await outbox("MeetupCancelled", id)).toHaveLength(1);
    expect(await outbox("MeetupLeft", id)).toHaveLength(1);
  });

  it("誘いの予定は T-04 のまま（どちらかが押すと予定ごと取り消す）", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    const invite = (await (
      await u.call("POST", "/api/v1/direct-invites", {
        token: a.token,
        body: { recipientId: b.id, startsAt: T("11:00"), endsAt: T("13:00") },
      })
    ).json()) as { id: string };
    const accepted = (await (
      await u.call("POST", `/api/v1/direct-invites/${invite.id}/responses`, { token: b.token, body: { response: "accept" } })
    ).json()) as { meetupId: string };
    await leave(b, accepted.meetupId);
    expect((await meetup(a, accepted.meetupId)).status).toBe("cancelled");
  });
});

describe("認証", () => {
  it("認証がなければ401", async () => {
    expect((await u.call("GET", "/api/v1/broadcasts?box=sent")).status).toBe(401);
    expect((await u.call("POST", "/api/v1/broadcasts", { body: {} })).status).toBe(401);
  });
});
