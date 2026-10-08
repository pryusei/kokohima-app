import { env } from "cloudflare:workers";
import { directInvitePageSchema, directInviteSchema, meetupPageSchema, meetupSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { DAY_MS, HOUR_MS } from "./domain/directInvite";

// 時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）
let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const iso = (ms: number) => new Date(ms).toISOString();
const T = (s: string) => `2026-10-10T${s}:00.000Z`;

async function pair(nameA = "あき", nameB = "びー") {
  const a = await u.user(nameA);
  const b = await u.user(nameB);
  await u.befriend(a, b);
  return { a, b };
}

function send(from: User, to: User | string, over: Record<string, unknown> = {}) {
  return u.call("POST", "/api/v1/direct-invites", {
    token: from.token,
    body: {
      recipientId: typeof to === "string" ? to : to.id,
      startsAt: T("11:00"),
      endsAt: T("13:00"),
      ...over,
    },
  });
}

async function sent(from: User, to: User, over: Record<string, unknown> = {}) {
  const res = await send(from, to, over);
  expect(res.status).toBe(201);
  return directInviteSchema.parse(await res.json());
}

const respond = (who: User, id: string, body: unknown) =>
  u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: who.token, body });
const decide = (who: User, id: string, decision: string) =>
  u.call("POST", `/api/v1/direct-invites/${id}/decide`, { token: who.token, body: { decision } });
const getInvite = (who: User, id: string) => u.call("GET", `/api/v1/direct-invites/${id}`, { token: who.token });
const cancel = (who: User, id: string) => u.call("POST", `/api/v1/meetups/${id}/cancel`, { token: who.token });

async function box(who: User, name: "received" | "sent", query = "") {
  const res = await u.call("GET", `/api/v1/direct-invites?box=${name}${query}`, { token: who.token });
  expect(res.status).toBe(200);
  return directInvitePageSchema.parse(await res.json());
}

async function meetups(who: User, query = "") {
  const res = await u.call("GET", `/api/v1/meetups${query ? `?${query}` : ""}`, { token: who.token });
  expect(res.status).toBe(200);
  return meetupPageSchema.parse(await res.json());
}

/** テストの間で DB は共有されるので、関係する ID を含むイベントだけを読む */
async function outbox(type: string, id: string) {
  const { results } = await env.DB.prepare(
    "SELECT payload FROM outbox WHERE type = ? AND payload LIKE ? ORDER BY created_at, rowid",
  )
    .bind(type, `%${id}%`)
    .all<{ payload: string }>();
  return results.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
}

async function hide(owner: User, from: User) {
  const res = await u.call("PATCH", `/api/v1/friends/${from.id}`, { token: owner.token, body: { sharesMyAvailability: false } });
  expect(res.status).toBe(200);
}

const addNight = (who: User, date = "2026-10-10") =>
  u.call("POST", "/api/v1/availabilities", { token: who.token, body: { date, preset: "night" } }); // 10:00〜14:00Z

describe("送信", () => {
  it("友達に送れる。201・Location・null の項目も省かない。期限の既定は開始まで", async () => {
    const { a, b } = await pair();
    const res = await send(a, b, { area: " 渋谷 ", message: "ごはん\nどう？", url: "https://example.com/x" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.headers.get("Location")).toBe(`/api/v1/direct-invites/${String(body.id)}`);
    expect(body).toMatchObject({
      kind: "kokodou",
      direction: "sent",
      status: "pending",
      counterpart: { id: b.id, displayName: "びー", avatarUrl: null },
      area: "渋谷",
      message: "ごはん\nどう？",
      expiresAt: T("11:00"),
      counterProposal: null,
      meetupId: null,
    });
    expect(Object.keys(body)).toContain("counterProposal");
  });

  it("見えている枠と重なれば asobo、接するだけは kokodou。見せない相手はここ暇がない相手と同じ kokodou", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    await u.befriend(a, c);
    await addNight(b);
    await addNight(c);
    await hide(c, a);
    expect((await sent(a, b)).kind).toBe("asobo");
    expect((await sent(a, b, { startsAt: T("14:00"), endsAt: T("15:00") })).kind).toBe("kokodou");
    expect((await sent(a, c)).kind).toBe("kokodou");
  });

  it("送った後に相手がここ暇を変えても kind は変わらない", async () => {
    const { a, b } = await pair();
    const created = (await (await addNight(b)).json()) as { id: string };
    const invite = await sent(a, b);
    expect(invite.kind).toBe("asobo");
    await u.call("DELETE", `/api/v1/availabilities/${created.id}`, { token: b.token });
    expect(directInviteSchema.parse(await (await getInvite(a, invite.id)).json()).kind).toBe("asobo");
  });

  it("期限：選んだ時間と開始日時の早いほう", async () => {
    const { a, b } = await pair();
    expect((await sent(a, b, { expiresIn: "1h" })).expiresAt).toBe(T("01:00"));
    expect((await sent(a, b, { expiresIn: "24h", startsAt: T("12:00") })).expiresAt).toBe(T("12:00"));
  });

  it.each([
    ["過去", { startsAt: "2026-10-09T23:00:00Z", endsAt: T("01:00") }],
    ["現在ちょうど", { startsAt: T("00:00"), endsAt: T("01:00") }],
    ["60日より先", { startsAt: iso(Date.parse(T("00:00")) + 61 * DAY_MS), endsAt: iso(Date.parse(T("01:00")) + 61 * DAY_MS) }],
    ["15分単位でない", { startsAt: T("11:10") }],
    ["30分未満", { endsAt: T("11:15") }],
    ["24時間超", { endsAt: "2026-10-11T11:15:00.000Z" }],
    ["エリアが31文字", { area: "あ".repeat(31) }],
    ["ひとことが101文字", { message: "あ".repeat(101) }],
    ["ひとことの改行が6個", { message: "a\nb\nc\nd\ne\nf\ng" }],
    ["制御文字", { message: "a\u0007b" }],
    ["書字方向の上書き", { area: "a‮b" }],
    ["http・https 以外の URL", { url: "javascript:alert(1)" }],
    ["認証情報つきの URL", { url: "https://user:pass@example.com/" }],
    ["先頭に制御文字と空白がある URL", { url: "\u0000 https://example.com/" }],
    ["タブを含む URL", { url: "https://exa\tmple.com/" }],
    ["書字方向の上書きを含む URL", { url: "https://example.com/\u202Eabc" }],
    ["余分な項目", { senderId: crypto.randomUUID() }],
    ["期限の値", { expiresIn: "2h" }],
  ])("入力の検証：%s は400", async (_label, over) => {
    const { a, b } = await pair();
    expect((await send(a, b, over)).status).toBe(400);
  });

  it("ひとことの改行は5個まで、文字数はコードポイントで数える。http も可", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b, { message: `${"😀".repeat(95)}\n\n\n\n\n`, url: "http://Example.COM" });
    expect(invite.message).toBe("😀".repeat(95));
    // 保存するのは正規化した URL
    expect(invite.url).toBe("http://example.com/");
    const five = await sent(a, b, { startsAt: T("14:00"), endsAt: T("15:00"), message: "1\n2\n3\n4\n5\n6", area: "" });
    expect(five.message).toBe("1\n2\n3\n4\n5\n6");
    expect(five.area).toBeNull();
  });

  it("友達でない・存在しない・自分・片方向の行しかない相手は、どれも同じ404", async () => {
    const { a, b } = await pair();
    const stranger = await u.user();
    const oneWay = await u.user();
    await u.befriend(a, oneWay);
    await env.DB.prepare("DELETE FROM friendships WHERE user_id = ? AND friend_id = ?").bind(oneWay.id, a.id).run();
    const bodies = new Set<string>();
    for (const to of [stranger.id, crypto.randomUUID(), a.id, oneWay.id]) {
      const res = await send(a, to);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Record<string, unknown>;
      bodies.add(JSON.stringify({ ...body, requestId: null }));
    }
    expect(bodies.size).toBe(1);
    expect(await outbox("DirectInviteSent", a.id)).toHaveLength(0);
    expect(b.id).toBeTruthy();
  });

  it("解除した元友達に、残っている誘いと同じ時間で送っても409でなく404（判定の順番）", async () => {
    const { a, b } = await pair();
    await sent(a, b);
    expect((await u.call("DELETE", `/api/v1/friends/${b.id}`, { token: a.token })).status).toBe(204);
    expect((await send(a, b)).status).toBe(404);
  });

  it("同じ相手・同じ時間の生きている誘いは409。同時に送っても1つ。期限切れになれば送り直せる", async () => {
    const { a, b } = await pair();
    const results = await Promise.all([send(a, b, { expiresIn: "1h" }), send(a, b, { expiresIn: "1h" })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await box(a, "sent")).items).toHaveLength(1);
    expect(await outbox("DirectInviteSent", a.id)).toHaveLength(1);
    await u.advance(HOUR_MS, a, b);
    expect((await send(a, b)).status).toBe(201);
  });

  it("送信上限：20件まで送れ、21件目は429と Retry-After。断られた誘いも数え、24時間たてば送れる", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 20; i++) {
      const start = Date.parse(T("01:00")) + i * HOUR_MS;
      const invite = await sent(a, b, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) });
      if (i === 0) expect((await respond(b, invite.id, { response: "decline" })).status).toBe(200);
      if (i === 0) await u.advance(30 * 60 * 1000, a, b);
    }
    const res = await send(a, b, { startsAt: "2026-10-12T01:00:00Z", endsAt: "2026-10-12T02:00:00Z" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: "rate_limited" });
    // いちばん古い送信は 00:00Z。今は 00:30Z なので、24時間を過ぎるまで 23時間30分
    expect(res.headers.get("Retry-After")).toBe(String(23.5 * 3600));
    await u.advance(23.5 * HOUR_MS, a, b);
    expect((await send(a, b, { startsAt: "2026-10-12T01:00:00Z", endsAt: "2026-10-12T02:00:00Z" })).status).toBe(201);
  });

  it("送信上限：期限切れの誘いも数え、429 では outbox に書かない", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 20; i++) {
      const start = Date.parse(T("02:00")) + i * HOUR_MS;
      await sent(a, b, { startsAt: iso(start), endsAt: iso(start + HOUR_MS), expiresIn: "1h" });
    }
    await u.advance(HOUR_MS, a, b);
    expect((await box(a, "sent")).items.every((i) => i.status === "expired")).toBe(true);
    const before = (await outbox("DirectInviteSent", a.id)).length;
    const res = await send(a, b, { startsAt: "2026-10-12T01:00:00Z", endsAt: "2026-10-12T02:00:00Z" });
    expect(res.status).toBe(429);
    expect(await outbox("DirectInviteSent", a.id)).toHaveLength(before);
  });

  it("送信上限：同時に送っても20件を超えない", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 17; i++) {
      const start = Date.parse(T("01:00")) + i * HOUR_MS;
      await sent(a, b, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) });
    }
    const results = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => {
        const start = Date.parse("2026-10-12T01:00:00Z") + i * HOUR_MS;
        return send(a, b, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) });
      }),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 429)).toHaveLength(2);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM direct_invites WHERE sender_id = ?").bind(a.id).first<{ n: number }>();
    expect(row?.n).toBe(20);
  });

  it("outbox の DirectInviteSent は ID と occurredAt だけ", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b, { message: "ひみつ", area: "渋谷", url: "https://example.com" });
    const [payload] = await outbox("DirectInviteSent", invite.id);
    expect(payload).toEqual({ userId: b.id, inviteId: invite.id, actorId: a.id, occurredAt: T("00:00") });
  });
});

describe("一覧と詳細", () => {
  it("受信・送信の振り分け、新しい順とカーソル、他人の誘いは出ない", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    await u.befriend(a, c);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const start = Date.parse(T("01:00")) + i * HOUR_MS;
      ids.push((await sent(a, b, { startsAt: iso(start), endsAt: iso(start + HOUR_MS) })).id);
      await u.advance(60 * 1000, a, b, c);
    }
    await sent(a, c);
    const p1 = await box(b, "received", "&limit=2");
    expect(p1.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(p1.items[0]).toMatchObject({ direction: "received", counterpart: { id: a.id } });
    const p2 = await box(b, "received", `&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();
    expect((await box(a, "sent")).items).toHaveLength(4);
    expect((await box(c, "received")).items).toHaveLength(1);
    expect((await box(c, "sent")).items).toHaveLength(0);
    expect((await u.call("GET", "/api/v1/direct-invites", { token: a.token })).status).toBe(400);
    expect((await u.call("GET", "/api/v1/direct-invites?box=sent&cursor=broken", { token: a.token })).status).toBe(400);
  });

  it("参加者でない人の詳細は404", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    const invite = await sent(a, b);
    expect((await getInvite(b, invite.id)).status).toBe(200);
    expect((await getInvite(c, invite.id)).status).toBe(404);
    expect((await getInvite(c, crypto.randomUUID())).status).toBe(404);
  });
});

describe("返答と決定", () => {
  it("行く：成立し、予定と参加者2人と MeetupConfirmed ができる", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    const res = await respond(b, invite.id, { response: "accept" });
    expect(res.status).toBe(200);
    const accepted = directInviteSchema.parse(await res.json());
    expect(accepted.status).toBe("confirmed");
    expect(accepted.meetupId).not.toBeNull();
    const meetup = meetupSchema.parse(await (await u.call("GET", `/api/v1/meetups/${accepted.meetupId}`, { token: a.token })).json());
    expect(meetup).toMatchObject({ startsAt: T("11:00"), endsAt: T("13:00"), status: "confirmed", directInviteId: invite.id });
    expect(meetup.participants.map((p) => p.id)).toEqual([b.id]);
    const rows = await env.DB.prepare("SELECT user_id FROM meetup_participants WHERE meetup_id = ?").bind(accepted.meetupId).all();
    expect(rows.results).toHaveLength(2);
    expect(await outbox("MeetupConfirmed", invite.id)).toEqual([
      { meetupId: accepted.meetupId, inviteId: invite.id, participantIds: [a.id, b.id], occurredAt: T("00:00") },
    ]);
  });

  it("今回は難しい：理由は受け取らない（reason を付けると400）", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    expect((await respond(b, invite.id, { response: "decline", reason: "忙しい" })).status).toBe(400);
    const res = await respond(b, invite.id, { response: "decline" });
    expect(directInviteSchema.parse(await res.json()).status).toBe("declined");
    expect((await box(a, "sent")).items[0]?.status).toBe("declined");
    expect(await outbox("DirectInviteDeclined", invite.id)).toEqual([
      { userId: a.id, inviteId: invite.id, actorId: b.id, occurredAt: T("00:00") },
    ]);
  });

  it("この時間なら：時間の検証、元と同じは400、2回目はできない。決めると代わりの時間で成立", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    expect((await respond(b, invite.id, { response: "counter", startsAt: T("11:00"), endsAt: T("13:00") })).status).toBe(400);
    expect((await respond(b, invite.id, { response: "counter", startsAt: T("11:10"), endsAt: T("13:00") })).status).toBe(400);
    expect((await respond(b, invite.id, { response: "counter" })).status).toBe(400);
    const res = await respond(b, invite.id, { response: "counter", startsAt: T("12:00"), endsAt: T("14:00") });
    const countered = directInviteSchema.parse(await res.json());
    expect(countered).toMatchObject({ status: "counter_proposed", counterProposal: { startsAt: T("12:00"), endsAt: T("14:00") } });
    const again = await respond(b, invite.id, { response: "counter", startsAt: T("15:00"), endsAt: T("16:00") });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "invalid_state" });
    const decided = directInviteSchema.parse(await (await decide(a, invite.id, "accept")).json());
    expect(decided.status).toBe("confirmed");
    const meetup = meetupSchema.parse(await (await u.call("GET", `/api/v1/meetups/${decided.meetupId}`, { token: b.token })).json());
    expect(meetup).toMatchObject({ startsAt: T("12:00"), endsAt: T("14:00") });
    expect(await outbox("DirectInviteCounterProposed", invite.id)).toEqual([
      { userId: a.id, inviteId: invite.id, actorId: b.id, occurredAt: T("00:00") },
    ]);
    expect(await outbox("MeetupConfirmed", invite.id)).toEqual([
      { meetupId: decided.meetupId, inviteId: invite.id, participantIds: [a.id, b.id], occurredAt: T("00:00") },
    ]);
  });

  it("見送る：skipped と DirectInviteSkipped", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    await respond(b, invite.id, { response: "counter", startsAt: T("12:00"), endsAt: T("14:00") });
    expect(directInviteSchema.parse(await (await decide(a, invite.id, "skip")).json()).status).toBe("skipped");
    expect(await outbox("DirectInviteSkipped", invite.id)).toEqual([
      { userId: b.id, inviteId: invite.id, actorId: a.id, occurredAt: T("00:00") },
    ]);
  });

  it("期限：期限後の返答は409 expired で、一覧と詳細も expired。期限切れでは outbox に書かない", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b, { expiresIn: "1h" });
    await u.advance(HOUR_MS, a, b);
    const res = await respond(b, invite.id, { response: "accept" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "expired" });
    expect((await box(a, "sent")).items[0]?.status).toBe("expired");
    expect(directInviteSchema.parse(await (await getInvite(b, invite.id)).json()).status).toBe("expired");
    expect(await outbox("MeetupConfirmed", invite.id)).toHaveLength(0);
  });

  it("代わりの時間の開始後は、決定が409 expired で、状態は expired（決定事項8）", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    await respond(b, invite.id, { response: "counter", startsAt: T("02:00"), endsAt: T("03:00") });
    await u.advance(2 * HOUR_MS, a, b);
    const res = await decide(a, invite.id, "accept");
    expect(await res.json()).toMatchObject({ code: "expired" });
    expect(directInviteSchema.parse(await (await getInvite(a, invite.id)).json()).status).toBe("expired");
  });

  it("状態が違えば invalid_state を expired より先に返す（pending への決定、counter_proposed への返答）", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b, { expiresIn: "1h" });
    expect(await (await decide(a, invite.id, "accept")).json()).toMatchObject({ code: "invalid_state" });
    await respond(b, invite.id, { response: "counter", startsAt: T("12:00"), endsAt: T("14:00") });
    await u.advance(2 * HOUR_MS, a, b);
    expect(await (await respond(b, invite.id, { response: "accept" })).json()).toMatchObject({ code: "invalid_state" });
  });

  it("同時に返答しても状態は1回だけ進み、予定は1つ。後続の文は何も書かない", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    const results = await Promise.all([
      respond(b, invite.id, { response: "accept" }),
      respond(b, invite.id, { response: "accept" }),
      respond(b, invite.id, { response: "decline" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const meetupRows = await env.DB.prepare("SELECT COUNT(*) AS n FROM meetups WHERE direct_invite_id = ?")
      .bind(invite.id)
      .first<{ n: number }>();
    const participants = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM meetup_participants p JOIN meetups m ON m.id = p.meetup_id WHERE m.direct_invite_id = ?",
    )
      .bind(invite.id)
      .first<{ n: number }>();
    const events =
      (await outbox("MeetupConfirmed", invite.id)).length + (await outbox("DirectInviteDeclined", invite.id)).length;
    const status = directInviteSchema.parse(await (await getInvite(a, invite.id)).json()).status;
    if (status === "confirmed") {
      expect([meetupRows?.n, participants?.n, events]).toEqual([1, 2, 1]);
    } else {
      expect([meetupRows?.n, participants?.n, events]).toEqual([0, 0, 1]);
    }
  });

  it("受信者が決定、送信者が返答、参加者でない人の操作は、どれも404", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    const invite = await sent(a, b);
    expect((await respond(a, invite.id, { response: "accept" })).status).toBe(404);
    expect((await respond(c, invite.id, { response: "accept" })).status).toBe(404);
    await respond(b, invite.id, { response: "counter", startsAt: T("12:00"), endsAt: T("14:00") });
    expect((await decide(b, invite.id, "accept")).status).toBe(404);
    expect((await decide(c, invite.id, "skip")).status).toBe(404);
    expect(directInviteSchema.parse(await (await getInvite(a, invite.id)).json()).status).toBe("counter_proposed");
  });

  it("友達を解除しても、既存の誘いは見られ、返答できる", async () => {
    const { a, b } = await pair();
    const invite = await sent(a, b);
    await u.call("DELETE", `/api/v1/friends/${a.id}`, { token: b.token });
    expect((await getInvite(b, invite.id)).status).toBe(200);
    expect((await respond(b, invite.id, { response: "accept" })).status).toBe(200);
  });
});

describe("成立した予定", () => {
  async function confirmed(a: User, b: User, start: string, end: string) {
    const invite = await sent(a, b, { startsAt: start, endsAt: end });
    return directInviteSchema.parse(await (await respond(b, invite.id, { response: "accept" })).json());
  }

  it("一覧はこれからの予定だけ、開始日時の順とカーソル。参加者でない人には404", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    const later = await confirmed(a, b, T("05:00"), T("06:00"));
    const sooner = await confirmed(a, b, T("01:00"), T("02:00"));
    const p1 = await meetups(a, "limit=1");
    expect(p1.items.map((m) => m.id)).toEqual([sooner.meetupId]);
    const p2 = await meetups(a, `limit=1&cursor=${p1.nextCursor}`);
    expect(p2.items.map((m) => m.id)).toEqual([later.meetupId]);
    expect(p2.nextCursor).toBeNull();
    await u.advance(2 * HOUR_MS, a, b, c);
    expect((await meetups(b)).items.map((m) => m.id)).toEqual([later.meetupId]);
    expect((await u.call("GET", `/api/v1/meetups/${later.meetupId}`, { token: c.token })).status).toBe(404);
    expect((await meetups(c)).items).toHaveLength(0);
  });

  it("やっぱり難しい：予定と元の誘いが cancelled。2回目は invalid_state、他人は404、開始後は expired", async () => {
    const { a, b } = await pair();
    const c = await u.user();
    const invite = await confirmed(a, b, T("05:00"), T("06:00"));
    const id = invite.meetupId ?? "";
    expect((await cancel(c, id)).status).toBe(404);
    const res = await cancel(b, id);
    expect(meetupSchema.parse(await res.json()).status).toBe("cancelled");
    expect(directInviteSchema.parse(await (await getInvite(a, invite.id)).json()).status).toBe("cancelled");
    expect((await meetups(a)).items).toHaveLength(0);
    expect(await outbox("MeetupCancelled", id)).toEqual([
      { meetupId: id, actorId: b.id, participantIds: expect.arrayContaining([a.id, b.id]), occurredAt: T("00:00") },
    ]);
    expect(await (await cancel(a, id)).json()).toMatchObject({ code: "invalid_state" });
    expect(await outbox("MeetupCancelled", id)).toHaveLength(1);

    const started = await confirmed(a, b, T("01:00"), T("02:00"));
    await u.advance(HOUR_MS, a, b);
    expect(await (await cancel(a, started.meetupId ?? "")).json()).toMatchObject({ code: "expired" });
  });
});

describe("認証", () => {
  it("認証がなければ401", async () => {
    expect((await u.call("GET", "/api/v1/direct-invites?box=sent")).status).toBe(401);
    expect((await u.call("POST", "/api/v1/direct-invites", { body: {} })).status).toBe(401);
    expect((await u.call("GET", "/api/v1/meetups")).status).toBe(401);
  });
});
