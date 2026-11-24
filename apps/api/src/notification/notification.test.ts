import { env } from "cloudflare:workers";
import { notificationPageSchema, notificationPreferencesSchema, type NotificationDto } from "@kokohima/shared";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { handleBatch, handleJob } from "../jobs/consumer";
import { dispatchOutbox } from "../jobs/dispatch";
import { countWithinLimit } from "./infra/repository";
import { runScheduled } from "../worker";

// 通知（docs/specs/T-07-notification.md）。時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  // サービス全体の数（user_id が ''）は利用者をまたぐので、テストごとに消す
  await env.DB.prepare("DELETE FROM notification_daily_counts WHERE user_id = ''").run();
});

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T = (s: string, day = "11") => `2026-10-${day}T${s}:00.000Z`;

/** メールアドレスつきの利用者 */
async function person(name: string, withEmail = true) {
  const who = await u.user(name);
  if (withEmail) {
    await env.DB.prepare("UPDATE users SET email = ?2 WHERE id = ?1").bind(who.id, `${who.id}@mail.test`).run();
  }
  return who;
}
const setCount = (userId: string, channel: string, count: number) =>
  env.DB.prepare(
    `INSERT INTO notification_daily_counts (user_id, day, channel, count) VALUES (?1, '2026-10-10', ?2, ?3)
     ON CONFLICT (user_id, day, channel) DO UPDATE SET count = ?3`,
  )
    .bind(userId, channel, count)
    .run();
const mailOf = (who: User) => `${who.id}@mail.test`;
const mailsTo = (who: User) => h.delivery.state.mails.filter((m) => m.to.includes(mailOf(who)));

/** 関係する ID を含む未処理のイベントを consumer に渡し、届けるメッセージも処理する */
async function flush(idPart: string, types?: string[]) {
  // お知らせの並び（行を作った時刻）がテストの中で決まるよう、時計を少し進める
  h.clock.now += 1;
  const { results } = await env.DB.prepare(
    "SELECT id, type, payload FROM outbox WHERE payload LIKE ?1 AND processed_at IS NULL ORDER BY created_at, rowid",
  )
    .bind(`%${idPart}%`)
    .all<{ id: string; type: string; payload: string }>();
  for (const r of results) {
    if (types && !types.includes(r.type)) continue;
    await handleJob(h.ctx, { kind: "outbox", id: r.id, type: r.type, payload: r.payload });
    await env.DB.prepare("UPDATE outbox SET processed_at = ?2 WHERE id = ?1").bind(r.id, h.clock.now).run();
  }
  await drain();
}
async function drain() {
  while (h.jobs.length > 0) {
    const job = h.jobs.shift();
    if (job?.kind === "notification_deliver") await handleJob(h.ctx, job);
  }
}

async function list(who: User): Promise<NotificationDto[]> {
  const res = await u.call("GET", "/api/v1/notifications", { token: who.token });
  expect(res.status).toBe(200);
  return notificationPageSchema.parse(await res.json()).items;
}
const rowsOf = async (who: User) =>
  (
    await env.DB.prepare("SELECT * FROM notifications WHERE user_id = ?1 ORDER BY inserted_at, id").bind(who.id).all<{
      id: string;
      kind: string;
      channel: string | null;
      outcome: string | null;
      delivered_at: number | null;
    }>()
  ).results;

const endpointFor = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}-${crypto.randomUUID()}`;
async function subscribe(who: User, endpoint = endpointFor("e")) {
  const res = await u.call("POST", "/api/v1/push/subscriptions", { token: who.token, body: { endpoint } });
  expect(res.status).toBe(204);
  return endpoint;
}

async function invite(from: User, to: User, startsAt = T("02:00"), endsAt = T("03:00")) {
  const res = await u.call("POST", "/api/v1/direct-invites", { token: from.token, body: { recipientId: to.id, startsAt, endsAt, message: "ひみつのひとこと" } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}
const respond = (who: User, id: string, body: unknown) =>
  u.call("POST", `/api/v1/direct-invites/${id}/responses`, { token: who.token, body });

async function pair() {
  const a = await person("あき");
  const b = await person("べに");
  await u.befriend(a, b);
  await flush(a.id, ["FriendshipEstablished"]);
  h.delivery.state.mails.length = 0;
  await env.DB.prepare("DELETE FROM notification_daily_counts WHERE user_id IN (?1, ?2)").bind(a.id, b.id).run();
  return { a, b };
}

describe("お知らせの作り方", () => {
  it("友達になると、2人の両方に1件ずつ届く", async () => {
    const a = await person("あき");
    const b = await person("べに");
    await u.befriend(a, b);
    await flush(a.id);
    const [na] = await list(a);
    const [nb] = await list(b);
    expect(na).toMatchObject({ kind: "friend_added", subjectId: b.id, actor: { id: b.id, displayName: "べに" } });
    expect(nb).toMatchObject({ kind: "friend_added", subjectId: a.id, actor: { id: a.id, displayName: "あき" } });
    expect(await list(a)).toHaveLength(1);
  });

  it("誘い → 受信者に届く。断り・別の時間の提案は送信者に届く。手を下した本人には届かない", async () => {
    const { a, b } = await pair();
    const first = await invite(a, b);
    await flush(first);
    expect((await list(b)).map((n) => n.kind)).toEqual(["invite_received", "friend_added"]);
    expect((await list(a)).map((n) => n.kind)).toEqual(["friend_added"]);
    await respond(b, first, { response: "decline" });
    await flush(first);
    expect((await list(a))[0]).toMatchObject({ kind: "invite_declined", subjectId: first, actor: { id: b.id } });
    const second = await invite(a, b, T("04:00"), T("05:00"));
    await respond(b, second, { response: "counter", startsAt: T("06:00"), endsAt: T("07:00") });
    await flush(second);
    expect((await list(a))[0]?.kind).toBe("invite_countered");
    await u.call("POST", `/api/v1/direct-invites/${second}/decide`, { token: a.token, body: { decision: "skip" } });
    await flush(second);
    expect((await list(b))[0]).toMatchObject({ kind: "invite_skipped", actor: { id: a.id } });
  });

  it("直接の誘いの成立は、成立させた人には届かない（受信者の「行く」・送信者の「決める」）", async () => {
    const { a, b } = await pair();
    const first = await invite(a, b);
    await respond(b, first, { response: "accept" });
    await flush(first);
    expect((await list(a))[0]).toMatchObject({ kind: "meetup_confirmed", actor: { id: b.id } });
    expect((await list(b)).some((n) => n.kind === "meetup_confirmed")).toBe(false);

    const second = await invite(a, b, T("04:00"), T("05:00"));
    await respond(b, second, { response: "counter", startsAt: T("06:00"), endsAt: T("07:00") });
    await flush(second);
    await u.call("POST", `/api/v1/direct-invites/${second}/decide`, { token: a.token, body: { decision: "accept" } });
    await flush(second);
    expect((await list(b))[0]).toMatchObject({ kind: "meetup_confirmed", actor: { id: a.id } });
    expect((await list(a)).filter((n) => n.kind === "meetup_confirmed")).toHaveLength(1);
  });

  it("成立した予定のキャンセルは、押した人でない方に届き、相手の名前を持たない", async () => {
    const { a, b } = await pair();
    const id = await invite(a, b);
    const accepted = await respond(b, id, { response: "accept" });
    const meetupId = ((await accepted.json()) as { meetupId: string }).meetupId;
    await flush(id);
    await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: a.token });
    await flush(meetupId);
    expect((await list(b))[0]).toMatchObject({ kind: "meetup_cancelled", subjectId: meetupId, actor: null });
    expect((await list(a)).some((n) => n.kind === "meetup_cancelled")).toBe(false);
  });

  describe("募集", () => {
    async function group() {
      const owner = await person("あき");
      const f1 = await person("べに");
      const f2 = await person("ちさ");
      const f3 = await person("だい");
      for (const f of [f1, f2, f3]) await u.befriend(owner, f);
      await flush(owner.id, ["FriendshipEstablished"]);
      const created = await u.call("POST", "/api/v1/broadcasts", {
        token: owner.token,
        body: { recipientIds: [f1.id, f2.id, f3.id], startsAt: T("02:00"), endsAt: T("03:00") },
      });
      const broadcastId = ((await created.json()) as { id: string }).id;
      await flush(broadcastId);
      return { owner, f1, f2, f3, broadcastId };
    }
    const kinds = async (who: User) => (await list(who)).map((n) => n.kind).filter((k) => k !== "friend_added");

    it("宛先の全員に同じく届く。応じても、応じるのをやめても、お知らせはできない", async () => {
      const { owner, f1, f2, f3, broadcastId } = await group();
      for (const f of [f1, f2, f3]) expect(await kinds(f)).toEqual(["broadcast_received"]);
      const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
      await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f1.token });
      await u.call("DELETE", `/api/v1/broadcasts/${broadcastId}/responses/me`, { token: f1.token });
      await flush(broadcastId);
      await flush(f1.id);
      const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
      expect(after?.n).toBe(before?.n);
      expect(await kinds(owner)).toEqual([]);
    });

    it("決まったことは参加者にだけ届く（募集者と、参加者でない宛先には届かない）。成立のお知らせは作らない", async () => {
      const { owner, f1, f2, f3, broadcastId } = await group();
      await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f1.token });
      await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f2.token });
      await u.call("POST", `/api/v1/broadcasts/${broadcastId}/decide`, { token: owner.token });
      await flush(broadcastId);
      expect(await kinds(f1)).toEqual(["broadcast_decided", "broadcast_received"]);
      expect(await kinds(f2)).toEqual(["broadcast_decided", "broadcast_received"]);
      expect(await kinds(f3)).toEqual(["broadcast_received"]);
      expect(await kinds(owner)).toEqual([]);
      expect((await list(f1))[0]).toMatchObject({ subjectId: broadcastId, actor: { id: owner.id } });
    });

    it("抜けたことは残った人にだけ届く。予定ごとの取り消しは、押した人と先に抜けた人に届かない", async () => {
      const { owner, f1, f2, f3, broadcastId } = await group();
      for (const f of [f1, f2, f3]) await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: f.token });
      const decided = await u.call("POST", `/api/v1/broadcasts/${broadcastId}/decide`, { token: owner.token });
      const meetupId = ((await decided.json()) as { meetupId: string }).meetupId;
      await flush(broadcastId);
      await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: f3.token });
      await flush(meetupId);
      expect((await kinds(f1))[0]).toBe("meetup_left");
      expect((await kinds(owner))[0]).toBe("meetup_left");
      expect(await kinds(f3)).not.toContain("meetup_left");
      expect((await list(f1))[0]?.actor).toBeNull();
      // 募集者が抜けると予定ごと取り消し
      await u.call("POST", `/api/v1/meetups/${meetupId}/cancel`, { token: owner.token });
      await flush(meetupId);
      expect((await kinds(f1))[0]).toBe("meetup_cancelled");
      expect((await kinds(f2))[0]).toBe("meetup_cancelled");
      expect(await kinds(owner)).not.toContain("meetup_cancelled");
      expect(await kinds(f3)).not.toContain("meetup_cancelled");
    });
  });

  it("「見せない」に切り替えても、お知らせはできない", async () => {
    const { a, b } = await pair();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect((await u.call("PATCH", `/api/v1/friends/${b.id}`, { token: a.token, body: { sharesMyAvailability: false } })).status).toBe(200);
    await flush(a.id);
    await flush(b.id);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM notifications").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("自動の断りと手の断りは、お知らせの行も応答も同じ形になる", async () => {
    const { a, b } = await pair();
    const manual = await invite(a, b);
    await respond(b, manual, { response: "decline" });
    const auto = await invite(a, b, T("04:00"), T("05:00"));
    const { declineForCancelledAvailability } = await import("../invitation/application/calendarFacing");
    h.clock.now += MIN;
    await declineForCancelledAvailability(h.ctx, {
      userId: b.id,
      ranges: [{ startsAt: Date.parse(T("04:00")), endsAt: Date.parse(T("05:00")) }],
      occurredAt: h.clock.now,
    });
    await flush(manual);
    await flush(auto);
    await u.advance(0, a, b);
    const declined = (await list(a)).filter((n) => n.kind === "invite_declined");
    expect(declined).toHaveLength(2);
    const shape = (n: NotificationDto) => JSON.stringify({ ...n, id: "", subjectId: "", createdAt: "", readAt: null });
    expect(shape(declined[0] as NotificationDto)).toBe(shape(declined[1] as NotificationDto));
  });

  it("自動取り消しは1件にまとまり、枠の数を持つ。連携の失効も届く", async () => {
    const a = await person("あき");
    const insert = (type: string, payload: unknown) =>
      env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(crypto.randomUUID(), type, JSON.stringify(payload), h.clock.now)
        .run();
    const occurredAt = new Date(h.clock.now).toISOString();
    await insert("AvailabilityCancelledByCalendar", {
      userId: a.id,
      ranges: [
        { startsAt: T("02:00"), endsAt: T("03:00") },
        { startsAt: T("04:00"), endsAt: T("05:00") },
      ],
      occurredAt,
    });
    await insert("CalendarReauthRequired", { userId: a.id, provider: "google", occurredAt });
    await flush(a.id);
    const items = await list(a);
    expect(items.map((n) => [n.kind, n.count]).sort()).toEqual([
      ["availability_cancelled", 2],
      ["calendar_reauth", null],
    ]);
  });

  it("退会した人宛てのイベントは、書かずに終わる（投げない）", async () => {
    const ghost = crypto.randomUUID();
    await expect(
      handleJob(h.ctx, {
        kind: "outbox",
        id: crypto.randomUUID(),
        type: "DirectInviteSent",
        payload: JSON.stringify({ userId: ghost, inviteId: crypto.randomUUID(), actorId: crypto.randomUUID(), occurredAt: new Date(h.clock.now).toISOString() }),
      }),
    ).resolves.toBeUndefined();
    expect(h.jobs).toHaveLength(0);
  });
});

describe("新しい端末でのログイン", () => {
  it("最初のログインでは送らない。2つめ以降はメールだけで送り、止める設定・上限・購読に関係しない", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const first = await h.login("google", sub);
    const me = (await (await u.call("GET", "/api/v1/me", { token: first.accessToken })).json()) as { id: string };
    const who: User = { id: me.id, token: first.accessToken, refreshToken: first.refreshToken, name: "あき" };
    await env.DB.prepare("UPDATE users SET email = ?2 WHERE id = ?1").bind(who.id, mailOf(who)).run();
    await flush(who.id);
    expect(await rowsOf(who)).toHaveLength(0);

    await subscribe(who);
    await u.call("PATCH", "/api/v1/me/notification-preferences", {
      token: who.token,
      body: { invites: false, broadcasts: false, meetups: false, friends: false, calendar: false },
    });
    await setCount(who.id, "email", 10);
    h.clock.now += 5 * MIN;
    await h.login("google", sub, {}, undefined);
    await flush(who.id);
    const rows = await rowsOf(who);
    expect(rows.map((r) => [r.kind, r.channel, r.outcome])).toEqual([["new_login", "email", "sent"]]);
    const [mail] = mailsTo(who);
    expect(mail?.subject).toBe("ここ暇：新しい端末でログインがありました");
    expect(mail?.text).toContain("2026/10/10 9:05");
    // T-23：HTML とテキストの両方を Resend に送る
    expect(mail?.html).toContain("<!DOCTYPE html>");
    expect(mail?.html).toContain("2026/10/10 9:05");
    expect(h.delivery.state.pushes).toHaveLength(0);
    expect((await list(who))[0]).toMatchObject({ kind: "new_login", actor: null });
  });
});

describe("メールアドレスのない利用者（LINE でログイン。T-32）", () => {
  async function lineUser(name: string): Promise<User> {
    const r = await h.login("line", `U${crypto.randomUUID().replace(/-/g, "")}`);
    expect((await u.call("PATCH", "/api/v1/me", { token: r.accessToken, body: { displayName: name } })).status).toBe(200);
    const me = (await (await u.call("GET", "/api/v1/me", { token: r.accessToken })).json()) as { id: string };
    return { id: me.id, token: r.accessToken, refreshToken: r.refreshToken, name };
  }

  it("新しい端末のログインは、メールを送らず（no_address）、プッシュにも切り替えず、お知らせ一覧に残す", async () => {
    const sub = `U${crypto.randomUUID().replace(/-/g, "")}`;
    const first = await h.login("line", sub);
    const me = (await (await u.call("GET", "/api/v1/me", { token: first.accessToken })).json()) as { id: string };
    const who: User = { id: me.id, token: first.accessToken, refreshToken: first.refreshToken, name: "らい" };
    await flush(who.id);
    await subscribe(who);
    h.clock.now += 5 * MIN;
    await h.login("line", sub);
    await flush(who.id);
    expect((await rowsOf(who)).map((r) => [r.kind, r.channel, r.outcome])).toEqual([["new_login", "email", "no_address"]]);
    expect(h.delivery.state.mails).toHaveLength(0);
    expect(h.delivery.state.pushes).toHaveLength(0);
    expect((await list(who))[0]).toMatchObject({ kind: "new_login" });
  });

  it("ほかのお知らせは、プッシュの購読があればプッシュで届き、なければ送らずにお知らせ一覧に残す", async () => {
    const a = await person("あき");
    const b = await lineUser("らい");
    const c = await person("しー");
    await u.befriend(a, b);
    await u.befriend(c, b);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).find((r) => r.kind === "invite_received")).toMatchObject({ channel: "email", outcome: "no_address" });
    await subscribe(b);
    await flush(await invite(c, b));
    expect((await rowsOf(b)).filter((r) => r.kind === "invite_received").at(-1)).toMatchObject({ channel: "push", outcome: "sent" });
    expect((await list(b)).filter((n) => n.kind === "invite_received")).toHaveLength(2);
  });
});

describe("重複と再試行", () => {
  it("同じイベントが2回届いても1件。届け終えたお知らせは送り直さない", async () => {
    const { a, b } = await pair();
    const id = await invite(a, b);
    const row = await env.DB.prepare("SELECT id, type, payload FROM outbox WHERE type = 'DirectInviteSent' AND payload LIKE ?1")
      .bind(`%${id}%`)
      .first<{ id: string; type: string; payload: string }>();
    const job = { kind: "outbox" as const, id: row?.id ?? "", type: "DirectInviteSent", payload: row?.payload ?? "{}" };
    await handleJob(h.ctx, job);
    await drain();
    await handleJob(h.ctx, job);
    await drain();
    expect((await list(b)).filter((n) => n.kind === "invite_received")).toHaveLength(1);
    expect(mailsTo(b)).toHaveLength(1);
  });

  it("送る途中で落ちたお知らせは、再試行で送り終える。1日の数は二重に増えない", async () => {
    const { a, b } = await pair();
    const id = await invite(a, b);
    h.delivery.state.mailNext.push(500);
    await expect(flush(id)).rejects.toThrow();
    expect((await rowsOf(b)).at(-1)?.delivered_at).toBeNull();
    const pending = (await rowsOf(b)).at(-1)?.id ?? "";
    await handleJob(h.ctx, { kind: "notification_deliver", notificationId: pending });
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "sent" });
    expect(mailsTo(b)).toHaveLength(1);
    expect(mailsTo(b)[0]?.idempotencyKey).toBe(pending);
    const count = await env.DB.prepare(
      "SELECT count FROM notification_daily_counts WHERE user_id = ?1 AND channel = 'email'",
    )
      .bind(b.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("カレンダーの処理が失敗しても、通知は届けたうえで投げる", async () => {
    const { a, b } = await pair();
    const id = await invite(a, b);
    await respond(b, id, { response: "accept" });
    const row = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = 'MeetupConfirmed' AND payload LIKE ?1")
      .bind(`%${id}%`)
      .first<{ id: string; payload: string }>();
    // 予定の ID を壊して、カレンダー側だけを失敗させる
    const broken = JSON.stringify({ ...(JSON.parse(row?.payload ?? "{}") as object), meetupId: 123 });
    await expect(handleJob(h.ctx, { kind: "outbox", id: row?.id ?? "", type: "MeetupConfirmed", payload: broken })).rejects.toThrow();
    await drain();
    expect((await rowsOf(a)).some((r) => r.kind === "meetup_confirmed")).toBe(true);
  });

  it("自動の断りが失敗しても通知は届けたうえで投げる。古い行（NOTIFICATION_START_AT より前）でも断りは行い、お知らせだけ作らない", async () => {
    const { a, b } = await pair();
    const id = await invite(a, b);
    await flush(id);
    const occurredAt = new Date(h.clock.now + MIN).toISOString();
    h.clock.now += 2 * MIN;
    await u.advance(0, a, b);
    const payload = { userId: b.id, ranges: [{ startsAt: T("02:00"), endsAt: T("03:00") }], occurredAt };
    const late = { env: { ...h.bindings, NOTIFICATION_START_AT: String(h.clock.now + DAY) }, deps: h.deps };
    await handleJob(late, { kind: "outbox", id: crypto.randomUUID(), type: "AvailabilityCancelledByCalendar", payload: JSON.stringify(payload) });
    expect((await rowsOf(b)).some((r) => r.kind === "availability_cancelled")).toBe(false);
    const status = ((await (await u.call("GET", `/api/v1/direct-invites/${id}`, { token: a.token })).json()) as { status: string }).status;
    expect(status).toBe("declined");

    await expect(
      handleJob(h.ctx, {
        kind: "outbox",
        id: crypto.randomUUID(),
        type: "AvailabilityCancelledByCalendar",
        payload: JSON.stringify({ userId: b.id, ranges: "broken", occurredAt }),
      }),
    ).rejects.toThrow();
    expect((await rowsOf(b)).some((r) => r.kind === "availability_cancelled")).toBe(true);
  });
});

describe("送り先と上限", () => {
  it("止めた種別はプッシュもメールも送らず、一覧には残る", async () => {
    const { a, b } = await pair();
    await u.call("PATCH", "/api/v1/me/notification-preferences", { token: b.token, body: { invites: false } });
    const id = await invite(a, b);
    await flush(id);
    expect((await rowsOf(b)).at(-1)).toMatchObject({ kind: "invite_received", channel: "none", outcome: "muted" });
    expect(mailsTo(b)).toHaveLength(0);
    expect((await list(b))[0]?.kind).toBe("invite_received");
  });

  it("購読があればプッシュだけ、なければメールだけ。メールアドレスがなければ送らない", async () => {
    const { a, b } = await pair();
    const c = await person("ちさ", false);
    await u.befriend(a, c);
    await flush(c.id, ["FriendshipEstablished"]);
    h.delivery.state.mails.length = 0;
    const endpoint = await subscribe(b);
    await flush(await invite(a, b));
    await flush(await invite(a, c));
    expect(h.delivery.state.pushes.map((p) => p.url)).toEqual([endpoint]);
    expect(mailsTo(b)).toHaveLength(0);
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "push", outcome: "sent" });
    expect((await rowsOf(c)).at(-1)).toMatchObject({ outcome: "no_address" });
    expect(h.delivery.state.mails).toHaveLength(0);
  });

  it("購読がすべて 404・410 で消えたら、同じお知らせをメールで送る", async () => {
    const { a, b } = await pair();
    const e1 = await subscribe(b);
    const e2 = await subscribe(b);
    h.delivery.state.pushStatus.set(e1, 410);
    h.delivery.state.pushStatus.set(e2, 404);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "sent" });
    expect(mailsTo(b)).toHaveLength(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(b.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("失効・期限切れのセッションの購読には送らず、その購読を消してメールに切り替える", async () => {
    const { a, b } = await pair();
    await subscribe(b);
    await env.DB.prepare("UPDATE sessions SET revoked_at = ?2 WHERE user_id = ?1").bind(b.id, h.clock.now).run();
    await flush(await invite(a, b));
    expect(h.delivery.state.pushes).toHaveLength(0);
    expect(mailsTo(b)).toHaveLength(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(b.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("メールの1日の上限は10件。日付が変われば戻る。切り替えたメールもメールの上限で数え、達していれば送らない", async () => {
    const { a, b } = await pair();
    await setCount(b.id, "email", 9);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "sent" });
    // 11件め：プッシュが使えずメールに切り替えるが、メールの上限に達している
    const dead = await subscribe(b);
    h.delivery.state.pushStatus.set(dead, 410);
    await flush(await invite(a, b, T("04:00"), T("05:00")));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "limited" });
    expect(mailsTo(b)).toHaveLength(1);
    expect((await list(b))[0]?.kind).toBe("invite_received");
    // 日付（東京）が変わると戻る
    await u.advance(DAY, a, b);
    await flush(await invite(a, b, T("06:00", "12"), T("07:00", "12")));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "sent" });
  });

  it("プッシュの1日の上限は30件。同時に届いても超えない", async () => {
    const { a, b } = await pair();
    await subscribe(b);
    await setCount(b.id, "push", 29);
    const ids = [await invite(a, b), await invite(a, b, T("04:00"), T("05:00")), await invite(a, b, T("06:00"), T("07:00"))];
    const jobs: string[] = [];
    for (const id of ids) {
      const row = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = 'DirectInviteSent' AND payload LIKE ?1")
        .bind(`%${id}%`)
        .first<{ id: string; payload: string }>();
      await handleJob(h.ctx, { kind: "outbox", id: row?.id ?? "", type: "DirectInviteSent", payload: row?.payload ?? "{}" });
    }
    for (const j of h.jobs.splice(0)) if (j.kind === "notification_deliver") jobs.push(j.notificationId);
    await Promise.all(jobs.map((notificationId) => handleJob(h.ctx, { kind: "notification_deliver", notificationId })));
    expect(h.delivery.state.pushes).toHaveLength(1);
    const outcomes = (await rowsOf(b)).filter((r) => r.kind === "invite_received").map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["limited", "limited", "sent"]);
  });

  it("予定・カレンダーのお知らせは1日の上限に数えず、上限に達していても送る", async () => {
    const { a, b } = await pair();
    await setCount(a.id, "email", 10);
    const id = await invite(a, b);
    await respond(b, id, { response: "accept" });
    await flush(id);
    expect((await rowsOf(a)).find((r) => r.kind === "meetup_confirmed")).toMatchObject({ channel: "email", outcome: "sent" });
    const count = await env.DB.prepare("SELECT count FROM notification_daily_counts WHERE user_id = ?1 AND channel = 'email'")
      .bind(a.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(10);
  });

  it("サービス全体の1日のメール数を超えたら送らない。新しい端末でのログインだけは送る", async () => {
    const { a, b } = await pair();
    await setCount("", "email", 90);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "limited" });
    expect(mailsTo(b)).toHaveLength(0);
    const insert = await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ?1").bind(b.id).first<{ id: string }>();
    await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)")
      .bind("second-session-" + b.id, b.id, h.clock.now + 1, h.clock.now + DAY)
      .run();
    expect(insert).not.toBeNull();
    await handleJob(h.ctx, {
      kind: "outbox",
      id: crypto.randomUUID(),
      type: "SessionStarted",
      payload: JSON.stringify({ userId: b.id, sessionId: "second-session-" + b.id, provider: "google", deviceSummary: "Chrome / macOS", occurredAt: new Date(h.clock.now).toISOString() }),
    });
    await drain();
    expect(mailsTo(b).map((m) => m.subject)).toEqual(["ここ暇：新しい端末でログインがありました"]);
  });
});

describe("プッシュ", () => {
  it("本文がなく、TTL と VAPID の署名（aud・exp・sub、ES256）が付く。リダイレクトを追わない", async () => {
    const { a, b } = await pair();
    const endpoint = await subscribe(b);
    await flush(await invite(a, b));
    const [push] = h.delivery.state.pushes;
    expect(push?.url).toBe(endpoint);
    expect(push?.bodyLength).toBe(0);
    expect(push?.redirect).toBe("manual");
    expect(push?.headers["content-length"]).toBe("0");
    expect(push?.headers.ttl).toBe("86400");
    const auth = push?.headers.authorization ?? "";
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(auth);
    expect(match?.[2]).toBe(env.VAPID_PUBLIC_KEY);
    const jwt = match?.[1] ?? "";
    expect(decodeProtectedHeader(jwt).alg).toBe("ES256");
    const claims = decodeJwt(jwt);
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@kokohima.test");
    expect((claims.exp ?? 0) - Math.floor(h.clock.now / 1000)).toBeLessThanOrEqual(12 * 60 * 60);
    // 相手の名前・ひとことを、プッシュのサービスに渡さない
    expect(JSON.stringify(push)).not.toMatch(/あき|ひみつ/);
  });

  it("5xx・429・タイムアウトは投げる（再試行）。400・403 はその購読だけ送れなかったとしてメールに切り替える", async () => {
    const { a, b } = await pair();
    const endpoint = await subscribe(b);
    for (const status of [500, 429, "throw"] as const) {
      h.delivery.state.pushStatus.set(endpoint, status);
      await expect(flush(await invite(a, b, T(`0${2 + h.delivery.state.pushes.length}:00`, "12"), T("09:00", "12")))).rejects.toThrow();
      h.jobs.length = 0;
    }
    h.delivery.state.pushStatus.set(endpoint, 403);
    h.delivery.state.pushes.length = 0;
    await flush(await invite(a, b, T("02:00", "13"), T("03:00", "13")));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "sent" });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(b.id).first<{ n: number }>();
    expect(left?.n).toBe(1);
  });
});

describe("メール", () => {
  it("Idempotency-Key がお知らせの ID。本文に相手の名前・ひとこと・ログイン用のリンクが入らない", async () => {
    const { a, b } = await pair();
    await flush(await invite(a, b));
    const [mail] = mailsTo(b);
    const row = (await rowsOf(b)).at(-1);
    expect(mail?.idempotencyKey).toBe(row?.id);
    expect(mail?.authorization).toBe("Bearer re_test_key");
    expect(mail?.from).toBe("ここ暇 <notify@kokohima.test>");
    expect(mail?.subject).toBe("ここ暇：新しいお知らせがあります");
    expect(mail?.text).toContain("誘いが届きました");
    expect(mail?.text).not.toMatch(/あき|ひみつ|token|code=/);
    expect(mail?.text).not.toMatch(/https:\/\/app\.test\/\S/);
  });

  it("429・5xx・タイムアウト・冪等キーの同時の再送は投げる。400・422 は failed にして再試行しない", async () => {
    const { a, b } = await pair();
    let n = 2;
    const next = () => invite(a, b, T(`0${n}:00`, "12"), T(`0${n++}:30`, "12"));
    for (const failure of [429, 503, "throw", { status: 409, body: { name: "concurrent_idempotent_requests" } }] as const) {
      h.delivery.state.mailNext.push(failure);
      await expect(flush(await next())).rejects.toThrow();
      h.jobs.length = 0;
    }
    for (const failure of [400, 422, { status: 409, body: { name: "invalid_idempotent_request" } }] as const) {
      h.delivery.state.mailNext.push(failure);
      await flush(await next());
      expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "failed" });
    }
    expect(mailsTo(b)).toHaveLength(0);
  });
});

describe("outbox と掃除", () => {
  it("通知だけの型で NOTIFICATION_START_AT より前の行は、送らずに処理済みにする。以後の行と T-06 の型は流す", async () => {
    const start = h.clock.now;
    const late = { env: { ...h.bindings, NOTIFICATION_START_AT: String(start) }, deps: h.deps };
    const row = async (type: string, createdAt: number) => {
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at) VALUES (?1, ?2, '{}', ?3)").bind(id, type, createdAt).run();
      return id;
    };
    const oldNotify = await row("DirectInviteSent", start - 1);
    const oldLogin = await row("SessionStarted", start - 30 * DAY);
    const oldCalendar = await row("AvailabilityCancelledByCalendar", start - 30 * DAY);
    const fresh = await row("DirectInviteSent", start);
    h.clock.now += 8 * DAY;
    h.jobs.length = 0;
    for (let n = 0; n < 40; n++) if ((await dispatchOutbox(late)) === 0) break;
    const sent = new Set(h.jobs.flatMap((j) => (j.kind === "outbox" ? [j.id] : [])));
    expect(sent.has(oldNotify)).toBe(false);
    expect(sent.has(oldLogin)).toBe(false);
    expect(sent.has(oldCalendar)).toBe(true);
    expect(sent.has(fresh)).toBe(true);
    const processed = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id IN (?1, ?2) AND processed_at IS NOT NULL")
      .bind(oldNotify, oldLogin)
      .first<{ n: number }>();
    expect(processed?.n).toBe(2);
    h.jobs.length = 0;
  });

  it("30日を過ぎたお知らせと、古い日ごとの数を Cron で掃除する（T-17）", async () => {
    const { a, b } = await pair();
    await flush(await invite(a, b));
    expect((await rowsOf(b)).length).toBeGreaterThan(0);
    h.clock.now += 31 * DAY;
    await runScheduled("* * * * *", h.bindings, h.deps);
    expect(await rowsOf(b)).toHaveLength(0);
    const counts = await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_daily_counts WHERE user_id = ?1").bind(b.id).first<{ n: number }>();
    expect(counts?.n).toBe(0);
    h.jobs.length = 0;
  });
});

describe("API", () => {
  it("一覧は行を作った順（新しい順）。遅れて届いたお知らせは上に出て、未読のまま残る。既読は upTo 以前だけ", async () => {
    const a = await person("あき");
    const make = async (occurredAt: number) => {
      await handleJob(h.ctx, {
        kind: "outbox",
        id: crypto.randomUUID(),
        type: "CalendarReauthRequired",
        payload: JSON.stringify({ userId: a.id, provider: "google", occurredAt: new Date(occurredAt).toISOString() }),
      });
      await drain();
    };
    const base = h.clock.now;
    await make(base + 2 * MIN);
    h.clock.now += 3 * MIN;
    await u.advance(0, a);
    const [seen] = await list(a);
    // 起きたのは前だが、行ができるのは後（outbox の遅れ）
    h.clock.now += MIN;
    await make(base);
    await u.advance(0, a);
    const items = await list(a);
    expect(items.map((n) => n.createdAt)).toEqual([new Date(base).toISOString(), new Date(base + 2 * MIN).toISOString()]);
    expect((await (await u.call("GET", "/api/v1/notifications/unread-count", { token: a.token })).json())).toEqual({ count: 2 });
    expect((await u.call("POST", "/api/v1/notifications/read", { token: a.token, body: { upTo: seen?.id } })).status).toBe(204);
    const after = await list(a);
    expect(after.map((n) => n.readAt !== null)).toEqual([false, true]);
    expect((await (await u.call("GET", "/api/v1/notifications/unread-count", { token: a.token })).json())).toEqual({ count: 1 });
  });

  it("カーソルで続きを読める。壊れたカーソル・範囲外の limit は400", async () => {
    const a = await person("あき");
    for (let n = 0; n < 3; n++) {
      h.clock.now += MIN;
      await handleJob(h.ctx, {
        kind: "outbox",
        id: crypto.randomUUID(),
        type: "CalendarReauthRequired",
        payload: JSON.stringify({ userId: a.id, provider: "google", occurredAt: new Date(h.clock.now).toISOString() }),
      });
    }
    await drain();
    await u.advance(0, a);
    const first = notificationPageSchema.parse(await (await u.call("GET", "/api/v1/notifications?limit=2", { token: a.token })).json());
    expect(first.items).toHaveLength(2);
    const second = notificationPageSchema.parse(
      await (await u.call("GET", `/api/v1/notifications?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`, { token: a.token })).json(),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect((await u.call("GET", "/api/v1/notifications?cursor=broken", { token: a.token })).status).toBe(400);
    expect((await u.call("GET", "/api/v1/notifications?limit=51", { token: a.token })).status).toBe(400);
  });

  it("他人のお知らせは、一覧・未読数に出ず、既読にもできない（他人の upTo は400）", async () => {
    const { a, b } = await pair();
    await flush(await invite(a, b));
    const mine = await list(b);
    const theirs = await list(a);
    expect(theirs.some((n) => mine.some((m) => m.id === n.id))).toBe(false);
    const res = await u.call("POST", "/api/v1/notifications/read", { token: a.token, body: { upTo: mine[0]?.id } });
    expect(res.status).toBe(400);
    expect((await list(b))[0]?.readAt).toBeNull();
    expect((await u.call("GET", "/api/v1/notifications")).status).toBe(401);
    expect((await u.call("POST", "/api/v1/notifications/read", { token: a.token, body: { upTo: "x" } })).status).toBe(400);
  });

  it("退会などで相手を読めないときは、actor を null で返す", async () => {
    const a = await person("あき");
    await handleJob(h.ctx, {
      kind: "outbox",
      id: crypto.randomUUID(),
      type: "DirectInviteSent",
      payload: JSON.stringify({ userId: a.id, inviteId: crypto.randomUUID(), actorId: crypto.randomUUID(), occurredAt: new Date(h.clock.now).toISOString() }),
    });
    await drain();
    expect((await list(a))[0]).toMatchObject({ kind: "invite_received", actor: null });
  });

  it("設定：行がなければ全部 true。部分更新できる。strict でない本文・空の本文は400。他人の設定は変わらない", async () => {
    const a = await person("あき");
    const b = await person("べに");
    const get = async (who: User) =>
      notificationPreferencesSchema.parse(await (await u.call("GET", "/api/v1/me/notification-preferences", { token: who.token })).json());
    expect(await get(a)).toEqual({ invites: true, broadcasts: true, meetups: true, friends: true, calendar: true, lockScreen: "hidden" });
    const res = await u.call("PATCH", "/api/v1/me/notification-preferences", { token: a.token, body: { broadcasts: false } });
    expect(notificationPreferencesSchema.parse(await res.json()).broadcasts).toBe(false);
    expect((await get(a)).invites).toBe(true);
    expect((await get(b)).broadcasts).toBe(true);
    for (const body of [{}, { invites: "no" }, { invites: false, extra: 1 }, { lockScreen: "full" }, { lockScreen: null }]) {
      expect((await u.call("PATCH", "/api/v1/me/notification-preferences", { token: a.token, body })).status).toBe(400);
    }
    expect((await u.call("GET", "/api/v1/me/notification-preferences")).status).toBe(401);
  });
});

describe("プッシュの購読", () => {
  const count = async (who: User) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(who.id).first<{ n: number }>())?.n;

  it("公開鍵を返す。登録した endpoint は暗号化して保存し、平文で残さない", async () => {
    const a = await person("あき");
    expect(await (await u.call("GET", "/api/v1/push/vapid-key", { token: a.token })).json()).toEqual({ publicKey: env.VAPID_PUBLIC_KEY });
    const endpoint = await subscribe(a);
    const row = await env.DB.prepare("SELECT endpoint_enc, endpoint_hash FROM push_subscriptions WHERE user_id = ?1")
      .bind(a.id)
      .first<{ endpoint_enc: string; endpoint_hash: string }>();
    expect(row?.endpoint_enc).toMatch(/^v1\.push-1\./);
    expect(JSON.stringify(row)).not.toContain(endpoint);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/x",
    "https://example.com/push",
    "https://push.apple.com.evil.test/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com:8443/x",
    "https://user:pass@fcm.googleapis.com/x",
    `https://fcm.googleapis.com/${"a".repeat(2100)}`,
  ])("許可していない宛先は400：%s", async (endpoint) => {
    const a = await person("あき");
    expect((await u.call("POST", "/api/v1/push/subscriptions", { token: a.token, body: { endpoint } })).status).toBe(400);
    expect(await count(a)).toBe(0);
  });

  it("上限10件を超えたら、いちばん古い購読と入れ替える。自分の再登録は数えない", async () => {
    const a = await person("あき");
    const endpoints: string[] = [];
    for (let n = 0; n < 10; n++) {
      h.clock.now += 1000;
      endpoints.push(await subscribe(a));
    }
    await subscribe(a, endpoints[9]);
    expect(await count(a)).toBe(10);
    h.clock.now += 1000;
    await subscribe(a);
    expect(await count(a)).toBe(10);
    const { sha256 } = await import("../shared/crypto");
    const oldest = await env.DB.prepare("SELECT 1 AS x FROM push_subscriptions WHERE endpoint_hash = ?1").bind(await sha256(endpoints[0] ?? "")).first();
    expect(oldest).toBeNull();
  });

  it("解除は、購読がなくても204。他人の購読は消せない。同じ endpoint を別の人が登録すると付け替える", async () => {
    const a = await person("あき");
    const b = await person("べに");
    const endpoint = await subscribe(a);
    const del = (who: User, e: string) => u.call("DELETE", "/api/v1/push/subscriptions", { token: who.token, body: { endpoint: e } });
    expect((await del(b, endpoint)).status).toBe(204);
    expect(await count(a)).toBe(1);
    expect((await del(b, endpointFor("none"))).status).toBe(204);
    await subscribe(b, endpoint);
    expect(await count(a)).toBe(0);
    expect(await count(b)).toBe(1);
    expect((await del(b, endpoint)).status).toBe(204);
    expect(await count(b)).toBe(0);
    expect((await u.call("POST", "/api/v1/push/subscriptions", { body: { endpoint } })).status).toBe(401);
  });

  it("ログアウトでそのセッションの購読が、全端末ログアウトで全部が消える。失効したセッションでは登録できない", async () => {
    const a = await person("あき");
    await subscribe(a);
    await u.call("POST", "/api/v1/auth/logout", { token: a.token, cookie: `__Host-kh_rt=${a.refreshToken}` });
    expect(await count(a)).toBe(0);
    expect((await u.call("POST", "/api/v1/push/subscriptions", { token: a.token, body: { endpoint: endpointFor("x") } })).status).toBe(401);

    const b = await person("べに");
    await subscribe(b);
    await u.call("POST", "/api/v1/auth/logout-all", { token: b.token, cookie: `__Host-kh_rt=${b.refreshToken}` });
    expect(await count(b)).toBe(0);
  });

  it("更新用トークンの再利用を検知して失効させたセッションの購読も消える", async () => {
    const a = await person("あき");
    await subscribe(a);
    const old = a.refreshToken;
    const first = await h.refresh(old);
    expect(first.status).toBe(200);
    const { cookieValue } = await import("../../test/identity-harness");
    const next = cookieValue(first, "__Host-kh_rt") ?? "";
    expect((await h.refresh(next)).status).toBe(200);
    // 2世代前のトークンが使われた：再利用として系列ごと失効
    expect((await h.refresh(old)).status).toBe(401);
    expect(await count(a)).toBe(0);
  });
});

describe("ログ", () => {
  it("メールアドレス・endpoint・API キー・相手の名前が出ない", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const { a, b } = await pair();
    const endpoint = await subscribe(b);
    await flush(await invite(a, b));
    h.delivery.state.pushStatus.set(endpoint, 403);
    await flush(await invite(a, b, T("04:00"), T("05:00")));
    h.delivery.state.mailNext.push(500);
    const message = {
      body: { kind: "notification_deliver" as const, notificationId: (await rowsOf(b)).at(-1)?.id ?? "" },
      attempts: 6,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await env.DB.prepare("UPDATE notifications SET delivered_at = NULL WHERE id = ?1").bind(message.body.notificationId).run();
    await handleBatch(h.ctx, { messages: [message] } as unknown as MessageBatch<never>);
    expect(message.retry).toHaveBeenCalled();
    const logged = [...log.mock.calls, ...err.mock.calls, ...warn.mock.calls].flat().join("\n");
    expect(logged).toContain("notification_delivered");
    expect(logged).not.toMatch(/mail\.test|fcm\.googleapis|re_test_key|あき|べに|ひみつ/);
    log.mockRestore();
    err.mockRestore();
    warn.mockRestore();
  });
});

/** 2つめのセッションを作り、その SessionStarted を流す（新端末のログイン） */
async function secondLogin(who: User, occurredAt = h.clock.now, ctx = h.ctx) {
  const sessionId = `second-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)")
    .bind(sessionId, who.id, h.clock.now + 1, h.clock.now + DAY)
    .run();
  await handleJob(ctx, {
    kind: "outbox",
    id: crypto.randomUUID(),
    type: "SessionStarted",
    payload: JSON.stringify({
      userId: who.id,
      sessionId,
      provider: "google",
      deviceSummary: "Chrome / macOS",
      occurredAt: new Date(occurredAt).toISOString(),
    }),
  });
  await drain();
}

describe("上限の組（決定事項8）", () => {
  it("新端末のログインのメールは1人1日5通まで。超えた分は一覧にだけ残る", async () => {
    const { b } = await pair();
    await setCount(b.id, "email_login", 5);
    await secondLogin(b);
    expect((await rowsOf(b)).find((r) => r.kind === "new_login")).toMatchObject({ channel: "email", outcome: "limited" });
    expect(mailsTo(b)).toHaveLength(0);
    expect((await list(b)).some((n) => n.kind === "new_login")).toBe(true);
  });

  it("予定・カレンダーは1人1日30通まで（プッシュ・メールそれぞれ）。誘いの上限とは別に数える", async () => {
    const { a, b } = await pair();
    await setCount(a.id, "email_priority", 30);
    const first = await invite(a, b);
    await respond(b, first, { response: "accept" });
    await flush(first);
    expect((await rowsOf(a)).find((r) => r.kind === "meetup_confirmed")).toMatchObject({ channel: "email", outcome: "limited" });

    await setCount(b.id, "email", 10);
    await subscribe(b);
    await setCount(b.id, "push_priority", 30);
    const second = await invite(a, b, T("04:00"), T("05:00"));
    await respond(b, second, { response: "counter", startsAt: T("06:00"), endsAt: T("07:00") });
    await flush(second);
    await u.call("POST", `/api/v1/direct-invites/${second}/decide`, { token: a.token, body: { decision: "accept" } });
    await flush(second);
    expect((await rowsOf(b)).find((r) => r.kind === "meetup_confirmed")).toMatchObject({ channel: "push", outcome: "limited" });
  });

  it("全体のメール数は段階で止める：誘い・募集・友達は70通、予定・カレンダーは90通、新端末のログインは常に送る", async () => {
    const { a, b } = await pair();
    await setCount("", "email", 70);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ kind: "invite_received", outcome: "limited" });

    const id = await invite(a, b, T("04:00"), T("05:00"));
    await respond(b, id, { response: "accept" });
    await flush(id);
    expect((await rowsOf(a)).find((r) => r.kind === "meetup_confirmed")).toMatchObject({ outcome: "sent" });

    await setCount("", "email", 90);
    // 予定の取り消しはメールにしない（T-35）ので、2つめの成立で確かめる
    const second = await invite(a, b, T("06:00"), T("07:00"));
    await respond(b, second, { response: "accept" });
    await flush(second);
    expect((await rowsOf(a)).filter((r) => r.kind === "meetup_confirmed").at(-1)).toMatchObject({ outcome: "limited" });

    await secondLogin(b);
    expect((await rowsOf(b)).find((r) => r.kind === "new_login")).toMatchObject({ outcome: "sent" });
    const total = await env.DB.prepare("SELECT count FROM notification_daily_counts WHERE user_id = '' AND channel = 'email'").first<{
      count: number;
    }>();
    expect(total?.count).toBe(91);
  });

  it("全体のメール数の上限で送らなかったとき、notification_mail_global_limit を種類だけで出す。利用者ごとの上限では出さない（docs/specs/T-13-monitoring.md）", async () => {
    const log = vi.spyOn(console, "log");
    const { a, b } = await pair();
    await setCount(b.id, "email", 10);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "limited" });
    expect(log.mock.calls.flat().join("\n")).not.toContain("notification_mail_global_limit");

    await setCount(b.id, "email", 0);
    await setCount("", "email", 70);
    log.mockClear();
    await flush(await invite(a, b, T("04:00"), T("05:00")));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "limited" });
    const lines = log.mock.calls.flat().map(String).filter((l) => l.includes("notification_mail_global_limit"));
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ event: "notification_mail_global_limit", kind: "invite_received" }]);
    expect(lines.join("\n")).not.toContain(b.id);
    log.mockRestore();
  });

  it("MAIL_DAILY_LIMIT が正の整数でなければ90として扱う（誘いは70通で止まる）", async () => {
    const { a, b } = await pair();
    const broken = { env: { ...h.bindings, MAIL_DAILY_LIMIT: "abc" }, deps: h.deps };
    await setCount("", "email", 69);
    const deliverWith = async (inviteId: string) => {
      h.clock.now += 1;
      const row = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = 'DirectInviteSent' AND payload LIKE ?1")
        .bind(`%${inviteId}%`)
        .first<{ id: string; payload: string }>();
      await handleJob(broken, { kind: "outbox", id: row?.id ?? "", type: "DirectInviteSent", payload: row?.payload ?? "{}" });
      for (const job of h.jobs.splice(0)) if (job.kind === "notification_deliver") await handleJob(broken, job);
    };
    await deliverWith(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ outcome: "sent" });
    await deliverWith(await invite(a, b, T("04:00"), T("05:00")));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ outcome: "limited" });
  });

  it("上限で数えられなかったお知らせには印を付けない（再試行でも、もう一度上限で確かめる）", async () => {
    const { a, b } = await pair();
    await flush(await invite(a, b));
    const row = (await rowsOf(b)).at(-1);
    await env.DB.prepare("UPDATE notifications SET counted_email_at = NULL WHERE id = ?1").bind(row?.id).run();
    await setCount(b.id, "email", 10);
    const n = { id: row?.id ?? "", userId: b.id };
    expect(await countWithinLimit(env.DB, n, "email", "email", "2026-10-10", 10, h.clock.now)).toBe(false);
    const mark = await env.DB.prepare("SELECT counted_email_at FROM notifications WHERE id = ?1").bind(row?.id).first<{
      counted_email_at: number | null;
    }>();
    expect(mark?.counted_email_at).toBeNull();
    await setCount(b.id, "email", 9);
    expect(await countWithinLimit(env.DB, n, "email", "email", "2026-10-10", 10, h.clock.now)).toBe(true);
    // 数えたあとの再試行は、もう数えない
    expect(await countWithinLimit(env.DB, n, "email", "email", "2026-10-10", 10, h.clock.now)).toBe(true);
    const count = await env.DB.prepare("SELECT count FROM notification_daily_counts WHERE user_id = ?1 AND channel = 'email'")
      .bind(b.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(10);
  });
});

describe("NOTIFICATION_START_AT", () => {
  it.each(["", "0", "abc"])("未設定・不正な値（%j）なら、お知らせを作らず、通知だけの型を流さず処理済みにもしない", async (raw) => {
    const { a, b } = await pair();
    const unset = { env: { ...h.bindings, NOTIFICATION_START_AT: raw }, deps: h.deps };
    const id = await invite(a, b);
    const row = await env.DB.prepare("SELECT id, payload, created_at FROM outbox WHERE type = 'DirectInviteSent' AND payload LIKE ?1")
      .bind(`%${id}%`)
      .first<{ id: string; payload: string; created_at: number }>();
    await handleJob(unset, { kind: "outbox", id: row?.id ?? "", type: "DirectInviteSent", payload: row?.payload ?? "{}" });
    expect((await rowsOf(b)).some((r) => r.kind === "invite_received")).toBe(false);

    const calendar = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at) VALUES (?1, 'CalendarConnected', '{}', ?2)")
      .bind(calendar, h.clock.now)
      .run();
    h.jobs.length = 0;
    for (let n = 0; n < 40; n++) if ((await dispatchOutbox(unset)) === 0) break;
    const sent = new Set(h.jobs.flatMap((j) => (j.kind === "outbox" ? [j.id] : [])));
    expect(sent.has(row?.id ?? "")).toBe(false);
    expect(sent.has(calendar)).toBe(true);
    const left = await env.DB.prepare("SELECT processed_at FROM outbox WHERE id = ?1").bind(row?.id).first<{ processed_at: number | null }>();
    expect(left?.processed_at).toBeNull();
    h.jobs.length = 0;
  });

  it("線は outbox の行を作った時刻で引く（occurredAt が後でも、行が前なら作らない）", async () => {
    const { a, b } = await pair();
    const late = { env: { ...h.bindings, NOTIFICATION_START_AT: String(h.clock.now + MIN) }, deps: h.deps };
    const id = await invite(a, b);
    const row = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = 'DirectInviteSent' AND payload LIKE ?1")
      .bind(`%${id}%`)
      .first<{ id: string; payload: string }>();
    const payload = JSON.stringify({ ...(JSON.parse(row?.payload ?? "{}") as object), occurredAt: new Date(h.clock.now + 2 * MIN).toISOString() });
    await handleJob(late, { kind: "outbox", id: row?.id ?? "", type: "DirectInviteSent", payload, createdAt: h.clock.now });
    expect((await rowsOf(b)).some((r) => r.kind === "invite_received")).toBe(false);
  });
});

describe("指摘への追加の確認", () => {
  it("他人宛てのお知らせは、自分の未読数に入らない。未認証は401", async () => {
    const { a, b } = await pair();
    await u.advance(0, a, b);
    await u.call("POST", "/api/v1/notifications/read", { token: a.token, body: { upTo: (await list(a))[0]?.id } });
    await flush(await invite(a, b));
    expect(await (await u.call("GET", "/api/v1/notifications/unread-count", { token: a.token })).json()).toEqual({ count: 0 });
    expect(((await (await u.call("GET", "/api/v1/notifications/unread-count", { token: b.token })).json()) as { count: number }).count).toBeGreaterThan(0);
    for (const [method, path, body] of [
      ["GET", "/api/v1/notifications/unread-count", undefined],
      ["POST", "/api/v1/notifications/read", { upTo: crypto.randomUUID() }],
      ["PATCH", "/api/v1/me/notification-preferences", { invites: false }],
      ["DELETE", "/api/v1/push/subscriptions", { endpoint: endpointFor("x") }],
      ["GET", "/api/v1/push/vapid-key", undefined],
    ] as const) {
      expect((await u.call(method, path, { body })).status).toBe(401);
    }
  });

  it.each([400, 401, 413])("プッシュの %d は、その購読だけ一時的でない失敗としてメールに切り替え、状態コードをログに出す", async (status) => {
    const log = vi.spyOn(console, "log");
    const { a, b } = await pair();
    const endpoint = await subscribe(b);
    h.delivery.state.pushStatus.set(endpoint, status);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ channel: "email", outcome: "sent" });
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(b.id).first<{ n: number }>();
    expect(left?.n).toBe(1);
    expect(log.mock.calls.flat().join("\n")).toContain(`"event":"notification_push_rejected","kind":"invite_received","status":${status}`);
    log.mockRestore();
  });

  it("メールの一時的でない失敗は、状態コードをログに出す", async () => {
    const log = vi.spyOn(console, "log");
    const { a, b } = await pair();
    h.delivery.state.mailNext.push(422);
    await flush(await invite(a, b));
    expect((await rowsOf(b)).at(-1)).toMatchObject({ outcome: "failed" });
    expect(log.mock.calls.flat().join("\n")).toContain('"event":"notification_mail_rejected","kind":"invite_received","status":422');
    log.mockRestore();
  });

  it("期限切れのセッションの購読には送らず、その購読を消してメールに切り替える", async () => {
    const { a, b } = await pair();
    await subscribe(b);
    await env.DB.prepare("UPDATE sessions SET expires_at = ?2 WHERE user_id = ?1").bind(b.id, h.clock.now - 1).run();
    await flush(await invite(a, b));
    expect(h.delivery.state.pushes).toHaveLength(0);
    expect(mailsTo(b)).toHaveLength(1);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?1").bind(b.id).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("「見せない」相手との間でも、誘いのお知らせは同じく届く", async () => {
    const { a, b } = await pair();
    expect((await u.call("PATCH", `/api/v1/friends/${b.id}`, { token: a.token, body: { sharesMyAvailability: false } })).status).toBe(200);
    await flush(await invite(b, a));
    await flush(await invite(a, b, T("04:00"), T("05:00")));
    expect((await list(a))[0]).toMatchObject({ kind: "invite_received", actor: { id: b.id } });
    expect((await list(b))[0]).toMatchObject({ kind: "invite_received", actor: { id: a.id } });
  });

  it("新端末のログインのメールの日時は、届けた時刻でなくログインの時刻（occurredAt）。セッションの ID は返さない", async () => {
    const { b } = await pair();
    await secondLogin(b, Date.parse("2026-10-09T21:30:00Z"));
    const [mail] = mailsTo(b);
    expect(mail?.text).toContain("2026/10/10 6:30");
    expect(mail?.text).not.toContain("9:00");
    const item = (await list(b)).find((n) => n.kind === "new_login");
    expect(item).toMatchObject({ subjectId: null, createdAt: "2026-10-09T21:30:00.000Z" });
  });

  it("日ごとの数は、UTC で3日前より前の日付だけを掃除する", async () => {
    const a = await person("あき");
    for (const day of ["2026-10-06", "2026-10-07"]) {
      await env.DB.prepare("INSERT INTO notification_daily_counts (user_id, day, channel, count) VALUES (?1, ?2, 'email', 1)")
        .bind(a.id, day)
        .run();
    }
    await runScheduled("* * * * *", h.bindings, h.deps);
    const { results } = await env.DB.prepare("SELECT day FROM notification_daily_counts WHERE user_id = ?1 ORDER BY day")
      .bind(a.id)
      .all<{ day: string }>();
    expect(results.map((r) => r.day)).toEqual(["2026-10-07"]);
    h.jobs.length = 0;
  });
});
