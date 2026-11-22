import { env } from "cloudflare:workers";
import { directInviteSchema, broadcastSchema, notificationPageSchema } from "@kokohima/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cookieValue, createHarness, ORIGIN } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { connectionsDueForSync } from "../calendar/infra/repository";
import { handleJob } from "../jobs/consumer";
import { cleanupExpired } from "../jobs/dispatch";
import { createFromEvent } from "../notification/application/delivery";
import { WITHDRAWAL_BATCH } from "../invitation/application/withdrawal";
import { REAUTH_WINDOW_MS } from "./application/withdrawal";
import * as repo from "./infra/repository";
import { insertManualWithinLimits } from "../availability/infra/repository";

// 退会（docs/specs/T-16-withdrawal.md）。時計は 2026-10-10T00:00:00Z
// テストの間で DB は共有されるので、関係する ID だけを読む

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T = (s: string, day = "11") => `2026-10-${day}T${s}:00.000Z`;

const withdraw = (who: User, body: unknown = { confirm: "withdraw" }, origin?: string | null) =>
  u.call("POST", "/api/v1/me/withdrawal", { token: who.token, body, origin, cookie: `__Host-kh_rt=${who.refreshToken}` });

const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${sql}`).bind(...binds).first<{ n: number }>())?.n ?? 0;

const userRow = (id: string) =>
  env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<{
    display_name: string | null;
    avatar_url: string | null;
    email: string | null;
    timezone: string;
    withdrawn_at: number | null;
    withdrawal_completed_at: number | null;
  }>();

/** outbox の行を consumer に直接渡す（Queue を通さない） */
async function deliver(type: string, id: string) {
  const { results } = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = ? AND payload LIKE ? ORDER BY created_at, rowid")
    .bind(type, `%${id}%`)
    .all<{ id: string; payload: string }>();
  for (const r of results) await handleJob(h.ctx, { kind: "outbox", id: r.id, type, payload: r.payload });
  return results.length;
}

const completeWithdrawalOf = (who: User) => deliver("UserWithdrew", who.id);

async function sendInvite(from: User, to: User, startsAt = T("11:00"), endsAt = T("13:00"), extra: Record<string, unknown> = {}) {
  const res = await u.call("POST", "/api/v1/direct-invites", {
    token: from.token,
    body: { recipientId: to.id, startsAt, endsAt, area: "渋谷", message: "ひとこと", ...extra },
  });
  expect(res.status).toBe(201);
  return directInviteSchema.parse(await res.json());
}

async function meetupOf(from: User, to: User, startsAt = T("11:00"), endsAt = T("13:00")) {
  const invite = await sendInvite(from, to, startsAt, endsAt);
  const res = await u.call("POST", `/api/v1/direct-invites/${invite.id}/responses`, { token: to.token, body: { response: "accept" } });
  expect(res.status).toBe(200);
  return directInviteSchema.parse(await res.json()).meetupId ?? "";
}

async function broadcastOf(owner: User, recipients: User[]) {
  const res = await u.call("POST", "/api/v1/broadcasts", {
    token: owner.token,
    body: { recipientIds: recipients.map((r) => r.id), startsAt: T("11:00"), endsAt: T("13:00"), area: "新宿", message: "募集のひとこと" },
  });
  expect(res.status).toBe(201);
  return broadcastSchema.parse(await res.json());
}

const respondTo = async (who: User, broadcastId: string) =>
  expect((await u.call("POST", `/api/v1/broadcasts/${broadcastId}/responses`, { token: who.token })).status).toBe(200);

const meetupStatus = async (id: string) =>
  (await env.DB.prepare("SELECT status FROM meetups WHERE id = ?").bind(id).first<{ status: string }>())?.status;

const inviteRow = (id: string) =>
  env.DB.prepare("SELECT status, expires_at, area, message, url FROM direct_invites WHERE id = ?")
    .bind(id)
    .first<{ status: string; expires_at: number; area: string | null; message: string | null; url: string | null }>();

describe("入口を止める段", () => {
  it("利用者の行を抜け殻にし、本人の行を消し、相手の行は残す。UserWithdrew を書き、Cookie を消す", async () => {
    const a = await u.user("あき");
    const b = await u.user("べに");
    const c = await u.user("ちか");
    await u.befriend(a, b);
    await u.befriend(b, c);
    await u.call("PATCH", `/api/v1/friends/${b.id}`, { token: a.token, body: { sharesMyAvailability: false } });
    await u.call("PATCH", `/api/v1/friends/${a.id}`, { token: b.token, body: { sharesMyAvailability: false } });
    expect((await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { startsAt: T("10:00"), endsAt: T("12:00") } })).status).toBe(201);
    expect((await u.call("POST", "/api/v1/availabilities", { token: b.token, body: { startsAt: T("10:00"), endsAt: T("12:00") } })).status).toBe(201);
    expect((await u.call("POST", "/api/v1/recurrence-rules", { token: a.token, body: { weekday: 1, preset: "night" } })).status).toBe(201);
    expect((await u.call("PATCH", "/api/v1/me/notification-preferences", { token: a.token, body: { invites: false } })).status).toBe(200);
    expect((await u.call("POST", "/api/v1/invite-links", { token: a.token, body: {} })).status).toBe(201);
    const invite = await sendInvite(b, a);

    const res = await withdraw(a);
    expect(res.status).toBe(204);
    expect(cookieValue(res, "__Host-kh_rt")).toBe("");

    const row = await userRow(a.id);
    expect(row).toMatchObject({ display_name: null, avatar_url: null, email: null, timezone: "Asia/Tokyo", withdrawal_completed_at: null });
    expect(row?.withdrawn_at).toBe(h.clock.now);
    for (const [table, column] of [
      ["sessions", "user_id"],
      ["user_identities", "user_id"],
      ["invite_links", "owner_id"],
      ["availabilities", "user_id"],
      ["recurrence_rules", "user_id"],
      ["notification_preferences", "user_id"],
      ["notifications", "user_id"],
    ] as const) {
      expect(await count(`${table} WHERE ${column} = ?`, a.id), table).toBe(0);
    }
    expect(await count("friendships WHERE user_id = ?1 OR friend_id = ?1", a.id)).toBe(0);
    expect(await count("sharing_policies WHERE owner_id = ?1 OR target_id = ?1", a.id)).toBe(0);
    expect(await count("outbox WHERE type = 'SessionStarted' AND json_extract(payload, '$.userId') = ?", a.id)).toBe(0);
    expect(await count("outbox WHERE type = 'UserWithdrew' AND json_extract(payload, '$.userId') = ?", a.id)).toBe(1);
    // 他人の行は残る
    expect(await count("friendships WHERE user_id = ? AND friend_id = ?", b.id, c.id)).toBe(1);
    expect(await count("availabilities WHERE user_id = ?", b.id)).toBe(1);
    expect(await count("sessions WHERE user_id = ?", b.id)).toBe(1);
    expect(await count("outbox WHERE type = 'SessionStarted' AND json_extract(payload, '$.userId') = ?", b.id)).toBe(1);
    expect(await count("direct_invites WHERE id = ?", invite.id)).toBe(1);
  });

  it("2回目はセッションがないので401で、何も変わらない", async () => {
    const a = await u.user();
    expect((await withdraw(a)).status).toBe(204);
    const before = await userRow(a.id);
    h.clock.now += MIN;
    expect((await withdraw(a)).status).toBe(401);
    expect(await userRow(a.id)).toEqual(before);
    expect(await count("outbox WHERE type = 'UserWithdrew' AND json_extract(payload, '$.userId') = ?", a.id)).toBe(1);
  });

  it("ログインから10分を過ぎたら403 reauth_required で、何も変えない。ちょうど10分なら退会できる", async () => {
    const a = await u.user();
    await u.advance(REAUTH_WINDOW_MS + 1, a);
    const res = await withdraw(a);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("reauth_required");
    expect((await userRow(a.id))?.withdrawn_at).toBeNull();
    expect((await u.call("GET", "/api/v1/me", { token: a.token })).status).toBe(200);

    const b = await u.user();
    await u.advance(REAUTH_WINDOW_MS, b);
    expect((await withdraw(b)).status).toBe(204);
  });

  it("確認の値がない・違うと400、同じオリジンでないと401、未認証は401。どれも何も変えない", async () => {
    const a = await u.user();
    expect((await withdraw(a, {})).status).toBe(400);
    expect((await withdraw(a, { confirm: "yes" })).status).toBe(400);
    expect((await withdraw(a, { confirm: "withdraw", userId: a.id })).status).toBe(400);
    expect((await withdraw(a, null)).status).toBe(400);
    expect((await withdraw(a, { confirm: "withdraw" }, "https://evil.test")).status).toBe(401);
    expect((await withdraw(a, { confirm: "withdraw" }, null)).status).toBe(401);
    expect((await u.call("POST", "/api/v1/me/withdrawal", { body: { confirm: "withdraw" } })).status).toBe(401);
    expect((await userRow(a.id))?.withdrawn_at).toBeNull();
  });

  it("他人の ID を渡す口がなく、退会するのは閲覧者本人だけ", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    // 本文の ID は受けない（strict）。パスにも ID がない
    expect((await withdraw(a, { confirm: "withdraw", userId: b.id })).status).toBe(400);
    expect((await u.call("POST", `/api/v1/me/withdrawal/${b.id}`, { token: a.token, body: { confirm: "withdraw" } })).status).toBe(404);
    expect((await withdraw(a)).status).toBe(204);
    expect((await userRow(b.id))?.withdrawn_at).toBeNull();
    expect((await u.call("GET", "/api/v1/me", { token: b.token })).status).toBe(200);
  });

  it("ログに ID・メール・名前を出さない", async () => {
    const info = vi.spyOn(console, "info");
    const a = await u.user("ひみつの名前");
    await withdraw(a);
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("user_withdrew"));
    expect(lines).toEqual([JSON.stringify({ event: "user_withdrew" })]);
    info.mockRestore();
  });
});

describe("退会のあと", () => {
  it("残っているアクセストークンでは書き込めず、更新用トークンも使えない。GET /me は404", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    const meetupId = await meetupOf(b, a);
    await withdraw(a);
    const writes: [string, string, unknown?][] = [
      ["PATCH", "/api/v1/me", { displayName: "x" }],
      ["PUT", "/api/v1/me/presets", { day: { start: "10:00", end: "17:00" }, evening: { start: "17:00", end: "21:00" }, night: { start: "21:00", end: "24:00" } }],
      ["POST", "/api/v1/availabilities", { startsAt: T("10:00"), endsAt: T("12:00") }],
      ["POST", "/api/v1/recurrence-rules", { weekday: 1, preset: "night" }],
      ["POST", "/api/v1/direct-invites", { recipientId: b.id, startsAt: T("15:00"), endsAt: T("16:00") }],
      ["POST", `/api/v1/meetups/${meetupId}/cancel`],
      ["POST", `/api/v1/meetups/${meetupId}/ics-links`],
      ["POST", "/api/v1/invite-links", {}],
      ["POST", `/api/v1/invite-links/${crypto.randomUUID()}/revoke`],
      ["DELETE", `/api/v1/friends/${b.id}`],
      ["PATCH", `/api/v1/friends/${b.id}`, { sharesMyAvailability: true }],
      ["POST", "/api/v1/notifications/read", { upTo: new Date(h.clock.now).toISOString() }],
      ["PATCH", "/api/v1/me/notification-preferences", { invites: true }],
      ["DELETE", "/api/v1/push/subscriptions", { endpoint: "https://fcm.googleapis.com/fcm/send/x" }],
      ["POST", "/api/v1/calendar/google/authorizations"],
    ];
    for (const [method, path, body] of writes) {
      expect((await u.call(method, path, { token: a.token, body })).status, `${method} ${path}`).toBe(401);
    }
    expect((await h.refresh(a.refreshToken)).status).toBe(401);
    expect((await u.call("GET", "/api/v1/me", { token: a.token })).status).toBe(404);
    expect(await count("presets WHERE user_id = ?", a.id)).toBe(0);
    expect(await meetupStatus(meetupId)).toBe("confirmed");
  });

  it("同じ Google でログインし直すと、新しい利用者になる", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const first = await h.login("google", sub);
    const before = (await (await u.call("GET", "/api/v1/me", { token: first.accessToken })).json()) as { id: string };
    expect(
      (await u.call("POST", "/api/v1/me/withdrawal", { token: first.accessToken, body: { confirm: "withdraw" } })).status,
    ).toBe(204);
    const again = await h.login("google", sub);
    const after = (await (await u.call("GET", "/api/v1/me", { token: again.accessToken })).json()) as { id: string };
    expect(after.id).not.toBe(before.id);
  });

  it("退会と同時に進んでいたログインの完了・カレンダーの連携・書き込みは、行を作り直さない", async () => {
    const sub = `sub-${crypto.randomUUID()}`;
    const first = await h.login("google", sub);
    const me = (await (await u.call("GET", "/api/v1/me", { token: first.accessToken })).json()) as { id: string };
    // ログインの途中（コールバックまで）
    const s = await h.start("google");
    h.respondWithIdToken((p) => h.signIdToken(p, { sub, nonce: s.nonce }));
    const cb = await h.callback("google", { code: "auth-code", state: s.state }, s.binding);
    const loginCode = new URL(cb.headers.get("Location") ?? "", ORIGIN).hash.replace("#code=", "");
    // カレンダーの連携の途中
    const auth = await u.call("POST", "/api/v1/calendar/google/authorizations", { token: first.accessToken });
    const state = new URL(((await auth.json()) as { authorizeUrl: string }).authorizeUrl).searchParams.get("state") ?? "";
    const calBinding = cookieValue(auth, "__Host-kh_cal") ?? "";

    expect((await u.call("POST", "/api/v1/me/withdrawal", { token: first.accessToken, body: { confirm: "withdraw" } })).status).toBe(204);

    expect((await h.complete(decodeURIComponent(loginCode), s.binding)).status).toBe(401);
    await h.request(`/api/v1/calendar/google/callback?${new URLSearchParams({ code: "auth-code", state })}`, {
      headers: { Cookie: `__Host-kh_cal=${calBinding}` },
    });
    expect(await count("calendar_connections WHERE user_id = ?", me.id)).toBe(0);
    expect(await count("sessions WHERE user_id = ?", me.id)).toBe(0);
    // アクセストークンの確認をすり抜けた要求があっても、リポジトリの条件で書かない
    await repo.updateDisplayName(repo.db(env.DB), me.id, "作り直し", h.clock.now);
    expect((await userRow(me.id))?.display_name).toBeNull();
    const added = await insertManualWithinLimits(
      env.DB,
      { id: crypto.randomUUID(), userId: me.id, startsAt: Date.parse(T("10:00")), endsAt: Date.parse(T("12:00")), label: null, now: h.clock.now },
      100,
    );
    expect(added).toBe(false);
    expect(await count("availabilities WHERE user_id = ?", me.id)).toBe(0);
    const created = await repo.createSessionRows(repo.db(env.DB), {
      sessionId: crypto.randomUUID(),
      userId: me.id,
      tokenHash: "x",
      tokenExpiresAt: h.clock.now + HOUR,
      sessionExpiresAt: h.clock.now + HOUR,
      event: { userId: me.id },
      now: h.clock.now,
    });
    expect(created).toBe(false);
    expect(await count("sessions WHERE user_id = ?", me.id)).toBe(0);
  });
});

describe("後始末の段", () => {
  it("カレンダー：「ここ暇」カレンダーを消し、revoke し、連携の行を消す。Google の失敗があっても終わる", async () => {
    for (const fail of [false, true]) {
      const a = await u.user();
      const b = await u.user();
      const auth = await u.call("POST", "/api/v1/calendar/google/authorizations", { token: a.token });
      const url = new URL(((await auth.json()) as { authorizeUrl: string }).authorizeUrl);
      await h.request(`/api/v1/calendar/google/callback?${new URLSearchParams({ code: "auth-code", state: url.searchParams.get("state") ?? "" })}`, {
        headers: { Cookie: `__Host-kh_cal=${cookieValue(auth, "__Host-kh_cal") ?? ""}` },
      });
      await u.befriend(a, b);
      const meetupId = await meetupOf(b, a);
      await deliver("MeetupConfirmed", meetupId);
      const calendarId = (await env.DB.prepare("SELECT calendar_id FROM calendar_connections WHERE user_id = ?").bind(a.id).first<{ calendar_id: string }>())?.calendar_id ?? "";
      expect(h.google.state.calendars.has(calendarId)).toBe(true);
      if (fail) {
        h.google.state.failNext.set(`DELETE /calendar/v3/calendars/${calendarId}`, 500);
        h.google.state.failNext.set("POST /revoke", 500);
      }
      await withdraw(a);
      await completeWithdrawalOf(a);
      if (!fail) {
        expect(h.google.state.calendars.has(calendarId)).toBe(false);
        expect(h.google.state.revoked.size).toBeGreaterThan(0);
      }
      expect(await count("calendar_connections WHERE user_id = ?", a.id)).toBe(0);
      expect((await userRow(a.id))?.withdrawal_completed_at).toBe(h.clock.now);
    }
  });

  it("これからの個別の予定は cancelled と MeetupCancelled。相手に退会したユーザーとして知らせる。開始後の予定は触らない", async () => {
    const a = await u.user();
    const b = await u.user("べに");
    await u.befriend(a, b);
    const upcoming = await meetupOf(b, a, T("11:00"), T("13:00"));
    const started = await meetupOf(a, b, T("00:30", "10"), T("02:00", "10"));
    h.clock.now = Date.parse(T("01:00", "10"));
    await u.advance(0, a, b);
    await reloginAs(a);
    await withdraw(a);
    await completeWithdrawalOf(a);
    expect(await meetupStatus(upcoming)).toBe("cancelled");
    expect(await meetupStatus(started)).toBe("confirmed");
    expect(await deliver("MeetupCancelled", upcoming)).toBe(1);
    const page = notificationPageSchema.parse(await (await u.call("GET", "/api/v1/notifications", { token: b.token })).json());
    expect(page.items.filter((n) => n.kind === "meetup_cancelled" && n.subjectId === upcoming)).toHaveLength(1);
    // 退会した人あてのお知らせは作らない
    expect(await count("notifications WHERE user_id = ?", a.id)).toBe(0);
  });

  it("募集の予定：退会した人だけが抜けて MeetupLeft。募集者が退会したときは予定ごと MeetupCancelled", async () => {
    const owner = await u.user();
    const x = await u.user();
    const y = await u.user();
    await u.befriend(owner, x);
    await u.befriend(owner, y);
    const bc = await broadcastOf(owner, [x, y]);
    await respondTo(x, bc.id);
    await respondTo(y, bc.id);
    const decided = broadcastSchema.parse(await (await u.call("POST", `/api/v1/broadcasts/${bc.id}/decide`, { token: owner.token })).json());
    const meetupId = decided.meetupId ?? "";
    await withdraw(x);
    await completeWithdrawalOf(x);
    expect(await meetupStatus(meetupId)).toBe("confirmed");
    expect(await count("outbox WHERE type = 'MeetupLeft' AND json_extract(payload, '$.meetupId') = ?", meetupId)).toBe(1);
    await withdraw(owner);
    await completeWithdrawalOf(owner);
    expect(await meetupStatus(meetupId)).toBe("cancelled");
    expect(await count("outbox WHERE type = 'MeetupCancelled' AND json_extract(payload, '$.meetupId') = ?", meetupId)).toBe(1);
  });

  it("返事待ち：受けた pending は declined、送った pending は期限切れ、counter_proposed は skipped、open の募集は締め切り。期限を過ぎた誘いは触らない", async () => {
    const a = await u.user();
    const b = await u.user();
    const c = await u.user();
    await u.befriend(a, b);
    await u.befriend(a, c);
    const received = await sendInvite(b, a, T("11:00"), T("12:00"));
    const sent = await sendInvite(a, b, T("13:00"), T("14:00"));
    const old = await sendInvite(a, c, T("15:00"), T("16:00"), { expiresIn: "1h" });
    const countered = await sendInvite(c, a, T("17:00"), T("18:00"));
    await u.call("POST", `/api/v1/direct-invites/${countered.id}/responses`, {
      token: a.token,
      body: { response: "counter", startsAt: T("19:00"), endsAt: T("20:00") },
    });
    const bc = await broadcastOf(a, [b, c]);
    h.clock.now += 2 * HOUR;
    await u.advance(0, a, b);
    await reloginAs(a);
    const oldExpiry = (await inviteRow(old.id))?.expires_at;

    await withdraw(a);
    await completeWithdrawalOf(a);
    expect((await inviteRow(received.id))?.status).toBe("declined");
    expect(await count("outbox WHERE type = 'DirectInviteDeclined' AND json_extract(payload, '$.inviteId') = ?", received.id)).toBe(1);
    expect(await inviteRow(sent.id)).toMatchObject({ status: "pending", expires_at: h.clock.now });
    expect((await inviteRow(countered.id))?.status).toBe("skipped");
    expect((await inviteRow(old.id))?.expires_at).toBe(oldExpiry);
    // 相手には期限切れ・締め切りに見える
    const seen = directInviteSchema.parse(await (await u.call("GET", `/api/v1/direct-invites/${sent.id}`, { token: b.token })).json());
    expect(seen.status).toBe("expired");
    expect(seen.counterpart).toEqual({ id: a.id, displayName: null, avatarUrl: null, withdrawn: true });
    const closed = broadcastSchema.parse(await (await u.call("GET", `/api/v1/broadcasts/${bc.id}`, { token: b.token })).json());
    expect(closed.status).toBe("closed");
    // 通知は受けた pending の「今回は難しい」だけ。お知らせの相手は withdrawn: true
    expect(await count("outbox WHERE type = 'DirectInviteDeclined' AND json_extract(payload, '$.actorId') = ?", a.id)).toBe(1);
    await deliver("DirectInviteDeclined", received.id);
    const page = notificationPageSchema.parse(await (await u.call("GET", "/api/v1/notifications", { token: b.token })).json());
    const declined = page.items.find((n) => n.kind === "invite_declined" && n.subjectId === received.id);
    expect(declined?.actor).toEqual({ id: a.id, displayName: null, avatarUrl: null, withdrawn: true });
  });

  it("書いた内容：送った誘い・作った募集の area・message・url を消し、リンクの参照も消す。相手が書いた内容は残る", async () => {
    const a = await u.user();
    const b = await u.user();
    const c = await u.user();
    await u.befriend(a, b);
    await u.befriend(a, c);
    const mine = await sendInvite(a, b, T("11:00"), T("12:00"), { url: "https://ogp.example/page" });
    const theirs = await sendInvite(b, a, T("13:00"), T("14:00"));
    const bc = await broadcastOf(a, [b, c]);
    const previewId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, claimed_at, fetched_at) VALUES (?1, ?2, 'ok', ?3, ?3)").bind(
        previewId,
        crypto.randomUUID(),
        h.clock.now,
      ),
      env.DB.prepare("INSERT INTO link_preview_refs (id, direct_invite_id, preview_id, created_at) VALUES (?1, ?2, ?3, ?4)").bind(
        crypto.randomUUID(),
        mine.id,
        previewId,
        h.clock.now,
      ),
    ]);
    expect(await count("link_preview_refs WHERE direct_invite_id = ?", mine.id)).toBe(1);

    await withdraw(a);
    await completeWithdrawalOf(a);
    expect(await inviteRow(mine.id)).toMatchObject({ area: null, message: null, url: null });
    expect(await inviteRow(theirs.id)).toMatchObject({ area: "渋谷", message: "ひとこと" });
    const b2 = await env.DB.prepare("SELECT area, message, url FROM broadcasts WHERE id = ?").bind(bc.id).first();
    expect(b2).toEqual({ area: null, message: null, url: null });
    expect(await count("link_preview_refs WHERE direct_invite_id = ?", mine.id)).toBe(0);
    // 消したあとに LinkAttached が処理されても参照を作らない
    await deliver("LinkAttached", mine.id);
    expect(await count("link_preview_refs WHERE direct_invite_id = ?", mine.id)).toBe(0);
  });

  it("上限を超える件数は、投げて再試行で続きを進める", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    const n = WITHDRAWAL_BATCH + 5;
    const stmts = Array.from({ length: n }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO direct_invites (id, sender_id, recipient_id, kind, starts_at, ends_at, status, expires_at, created_at)
         VALUES (?1, ?2, ?3, 'time', ?4, ?5, 'pending', ?6, ?7)`,
      ).bind(crypto.randomUUID(), b.id, a.id, Date.parse(T("11:00")) + i * HOUR, Date.parse(T("11:30")) + i * HOUR, Date.parse(T("10:00")), h.clock.now),
    );
    await env.DB.batch(stmts);
    await withdraw(a);
    const row = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = 'UserWithdrew' AND json_extract(payload, '$.userId') = ?").bind(a.id).first<{ id: string; payload: string }>();
    const job = { kind: "outbox" as const, id: row?.id ?? "", type: "UserWithdrew", payload: row?.payload ?? "" };
    await expect(handleJob(h.ctx, job)).rejects.toThrow();
    expect((await userRow(a.id))?.withdrawal_completed_at).toBeNull();
    await handleJob(h.ctx, job);
    expect(await count("direct_invites WHERE recipient_id = ? AND status = 'pending'", a.id)).toBe(0);
    expect((await userRow(a.id))?.withdrawal_completed_at).not.toBeNull();
  });

  it("毎分の掃除が、1時間を過ぎて終わっていない後始末を呼び直す", async () => {
    const a = await u.user();
    await withdraw(a);
    // DB はテストの間で共有されるので、ほかのテストで退会した人の後始末は終わったことにしておく
    await env.DB.prepare("UPDATE users SET withdrawal_completed_at = 0 WHERE withdrawn_at IS NOT NULL AND withdrawal_completed_at IS NULL AND id != ?")
      .bind(a.id)
      .run();
    h.clock.now += 30 * MIN;
    await cleanupExpired(h.ctx);
    expect((await userRow(a.id))?.withdrawal_completed_at).toBeNull();
    h.clock.now += 31 * MIN;
    await cleanupExpired(h.ctx);
    expect((await userRow(a.id))?.withdrawal_completed_at).toBe(h.clock.now);
  });
});

describe("相手から見た退会した人", () => {
  it("友達の一覧から消え、誘いは送れない。履歴の相手は withdrawn: true（列に名前が残っていても null）", async () => {
    const a = await u.user("あき");
    const b = await u.user();
    await u.befriend(a, b);
    const invite = await sendInvite(b, a);
    await withdraw(a);
    await env.DB.prepare("UPDATE users SET display_name = '残った名前' WHERE id = ?").bind(a.id).run();
    const friends = (await (await u.call("GET", "/api/v1/friends", { token: b.token })).json()) as { items: { id: string }[] };
    expect(friends.items.map((f) => f.id)).not.toContain(a.id);
    expect((await u.call("GET", `/api/v1/friends/${a.id}`, { token: b.token })).status).toBe(404);
    expect(
      (await u.call("POST", "/api/v1/direct-invites", { token: b.token, body: { recipientId: a.id, startsAt: T("15:00"), endsAt: T("16:00") } })).status,
    ).toBe(404);
    const seen = directInviteSchema.parse(await (await u.call("GET", `/api/v1/direct-invites/${invite.id}`, { token: b.token })).json());
    expect(seen.counterpart).toEqual({ id: a.id, displayName: null, avatarUrl: null, withdrawn: true });
  });

  it("退会のあと、相手の「行く」「この時間で決める」は409で予定ができない", async () => {
    const a = await u.user();
    const b = await u.user();
    await u.befriend(a, b);
    const toB = await sendInvite(a, b, T("11:00"), T("12:00"));
    const toA = await sendInvite(b, a, T("13:00"), T("14:00"));
    await u.call("POST", `/api/v1/direct-invites/${toA.id}/responses`, {
      token: a.token,
      body: { response: "counter", startsAt: T("15:00"), endsAt: T("16:00") },
    });
    await withdraw(a);
    // 後始末の前（同時の操作）
    expect((await u.call("POST", `/api/v1/direct-invites/${toB.id}/responses`, { token: b.token, body: { response: "accept" } })).status).toBe(409);
    expect((await u.call("POST", `/api/v1/direct-invites/${toA.id}/decide`, { token: b.token, body: { decision: "accept" } })).status).toBe(409);
    expect(await count("meetups WHERE direct_invite_id IN (?, ?)", toB.id, toA.id)).toBe(0);
  });

  it("募集の「決める」：退会した人を参加者にしない。応じたのが退会した人だけなら409。応じた人数は変わらない", async () => {
    const owner = await u.user();
    const x = await u.user();
    const y = await u.user();
    await u.befriend(owner, x);
    await u.befriend(owner, y);
    const both = await broadcastOf(owner, [x, y]);
    await respondTo(x, both.id);
    await respondTo(y, both.id);
    const only = await broadcastOf(owner, [x, y]);
    await respondTo(x, only.id);
    const before = broadcastSchema.parse(await (await u.call("GET", `/api/v1/broadcasts/${both.id}`, { token: owner.token })).json());
    await withdraw(x);
    const after = broadcastSchema.parse(await (await u.call("GET", `/api/v1/broadcasts/${both.id}`, { token: owner.token })).json());
    expect(after.responseCount).toBe(before.responseCount);
    expect((await u.call("POST", `/api/v1/broadcasts/${only.id}/decide`, { token: owner.token })).status).toBe(409);
    const decided = await u.call("POST", `/api/v1/broadcasts/${both.id}/decide`, { token: owner.token });
    expect(decided.status).toBe(200);
    const meetupId = broadcastSchema.parse(await decided.json()).meetupId ?? "";
    const { results } = await env.DB.prepare("SELECT user_id FROM meetup_participants WHERE meetup_id = ?").bind(meetupId).all<{ user_id: string }>();
    expect(results.map((r) => r.user_id).sort()).toEqual([owner.id, y.id].sort());
  });

  it("退会した人あてのお知らせを作らず、定期の確認は退会した人の連携を扱わない", async () => {
    const a = await u.user();
    const b = await u.user();
    await env.DB.prepare(
      "INSERT INTO calendar_connections (user_id, provider, status, refresh_token_enc, connected_at, updated_at) VALUES (?1, 'google', 'active', 'x', ?2, ?2)",
    ).bind(a.id, h.clock.now).run();
    await withdraw(a);
    await createFromEvent(h.ctx, {
      id: crypto.randomUUID(),
      type: "FriendshipEstablished",
      payload: { userId: a.id, friendId: b.id, occurredAt: new Date(h.clock.now).toISOString() },
      outboxCreatedAt: h.clock.now,
    });
    expect(await count("notifications WHERE user_id = ?", a.id)).toBe(0);
    const due = await connectionsDueForSync(env.DB, h.clock.now + HOUR, 0, 1000);
    expect(due.map((d) => d.user_id)).not.toContain(a.id);
  });
});

/** 直前のログインをやり直す（同じ利用者のまま新しいセッション）。テスト用に、セッションの作成時刻を今にする */
async function reloginAs(who: User) {
  await env.DB.prepare("UPDATE sessions SET created_at = ?2 WHERE user_id = ?1").bind(who.id, h.clock.now).run();
  return who;
}
