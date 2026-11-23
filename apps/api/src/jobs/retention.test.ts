import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import migration from "../../migrations/0014_retention.sql?raw";
import { createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { NOTIFICATION_CLEANUP_BATCH, NOTIFICATION_RETENTION_MS } from "../notification/application/delivery";
import { PUSH_SUBSCRIPTION_CLEANUP_BATCH } from "../notification/application/subscriptions";
import { runScheduled } from "../worker";
import { BROADCAST_CLEANUP_BATCH, cleanupExpired, CLEANUP_BATCH, exceptionCutoffDate, RETENTION_MS } from "./dispatch";

// 古いデータの掃除と保持期間（docs/specs/T-17-retention.md）。時計は 2026-10-10T00:00:00Z（土曜、東京は 09:00）

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;
let logs: string[];

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T = (s: string, day = "10") => `2026-10-${day}T${s}:00.000Z`;
const ms = (s: string, day = "10") => Date.parse(T(s, day));

const events = (name: string) =>
  logs.flatMap((l) => {
    try {
      const o = JSON.parse(l) as { event?: string };
      return o.event === name ? [o as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

const count = async (where: string, ...binds: unknown[]) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${where}`).bind(...binds).first<{ n: number }>())?.n ?? 0;

/** 時計を target まで進め、アクセストークンを取り直す（更新用トークンの期限30日を越えないよう、15日ずつ） */
async function advanceTo(target: number, ...users: User[]) {
  while (target - h.clock.now > 15 * DAY) await u.advance(15 * DAY, ...users);
  await u.advance(target - h.clock.now, ...users);
}

async function pair() {
  const a = await u.user("あき");
  const b = await u.user("べに");
  await u.befriend(a, b);
  return { a, b };
}

async function sendInvite(from: User, to: User, startsAt = T("11:00"), endsAt = T("13:00")) {
  const res = await u.call("POST", "/api/v1/direct-invites", { token: from.token, body: { recipientId: to.id, startsAt, endsAt } });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** 結果の行と、誘い・募集からの参照（T-08）を足す */
async function attachPreview(column: "direct_invite_id" | "broadcast_id", id: string) {
  const previewId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO link_previews (id, url_hash, status, claimed_at, fetched_at) VALUES (?1, ?2, 'ok', ?3, ?3)").bind(
      previewId,
      `h-${previewId}`,
      h.clock.now,
    ),
    env.DB.prepare(`INSERT INTO link_preview_refs (id, ${column}, preview_id, created_at) VALUES (?1, ?2, ?3, ?4)`).bind(
      crypto.randomUUID(),
      id,
      previewId,
      h.clock.now,
    ),
  ]);
}

async function icsLink(who: User, meetupId: string) {
  expect((await u.call("POST", `/api/v1/meetups/${meetupId}/ics-links`, { token: who.token })).status).toBe(200);
}

describe("終わった誘い・予定", () => {
  it("時間の終わりからちょうど30日の行は残り、それより前は状態によらず消える。予定・参加者・.ics の鍵・参照も消え、両方から404", async () => {
    const { a, b } = await pair();
    // 成立（予定・参加者・.ics の鍵・参照つき）
    const accepted = await sendInvite(a, b);
    const meetupId = ((await (await u.call("POST", `/api/v1/direct-invites/${accepted}/responses`, { token: b.token, body: { response: "accept" } })).json()) as { meetupId: string }).meetupId;
    await icsLink(a, meetupId);
    await icsLink(b, meetupId);
    await attachPreview("direct_invite_id", accepted);
    // 断った・返事のないまま期限切れ
    const declined = await sendInvite(a, b, T("12:00"), T("13:00"));
    expect((await u.call("POST", `/api/v1/direct-invites/${declined}/responses`, { token: b.token, body: { response: "decline" } })).status).toBe(200);
    const pending = await sendInvite(b, a, T("12:00"), T("13:00"));
    // 代わりの時間（元より遅く終わる）：代わりの時間の終わりで判定する
    const countered = await sendInvite(a, b, T("10:00"), T("11:00"));
    expect(
      (await u.call("POST", `/api/v1/direct-invites/${countered}/responses`, { token: b.token, body: { response: "counter", startsAt: T("13:00"), endsAt: T("15:00") } })).status,
    ).toBe(200);
    // まだ終わっていない誘い
    const future = await sendInvite(a, b, T("11:00", "20"), T("12:00", "20"));
    const ids = [accepted, declined, pending, countered, future];
    const left = async () => (await env.DB.prepare("SELECT id FROM direct_invites WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ids)).all<{ id: string }>()).results.map((r) => r.id).sort();

    // ちょうど30日：どれも残る
    await advanceTo(ms("13:00") + RETENTION_MS, a, b);
    await cleanupExpired(h.ctx);
    expect(await left()).toEqual([...ids].sort());
    expect((await u.call("GET", `/api/v1/meetups/${meetupId}`, { token: a.token })).status).toBe(200);

    await advanceTo(ms("13:00") + RETENTION_MS + 1, a, b);
    await cleanupExpired(h.ctx);
    expect(await left()).toEqual([countered, future].sort());
    expect(await count("meetups WHERE id = ?1", meetupId)).toBe(0);
    expect(await count("meetup_participants WHERE meetup_id = ?1", meetupId)).toBe(0);
    expect(await count("ics_tokens WHERE meetup_id = ?1", meetupId)).toBe(0);
    expect(await count("link_preview_refs WHERE direct_invite_id = ?1", accepted)).toBe(0);
    for (const who of [a, b]) {
      expect((await u.call("GET", `/api/v1/direct-invites/${accepted}`, { token: who.token })).status).toBe(404);
      expect((await u.call("GET", `/api/v1/meetups/${meetupId}`, { token: who.token })).status).toBe(404);
      const list = await u.call("GET", "/api/v1/meetups", { token: who.token });
      expect(JSON.stringify(await list.json())).not.toContain(meetupId);
      for (const boxName of ["sent", "received"]) {
        const page = await u.call("GET", `/api/v1/direct-invites?box=${boxName}`, { token: who.token });
        const text = JSON.stringify(await page.json());
        expect(text).not.toContain(accepted);
        expect(text).not.toContain(declined);
      }
    }

    // 代わりの時間の終わりから30日を過ぎたら消える
    await advanceTo(ms("15:00") + RETENTION_MS + 1, a, b);
    await cleanupExpired(h.ctx);
    expect(await left()).toEqual([future]);
  });
});

describe("終わった募集・予定", () => {
  it("時間の終わりから30日を過ぎた募集は、宛先・予定・参加者・.ics の鍵・参照と一緒に消え、両方から404。30日以内は残る", async () => {
    const owner = await u.user("あき");
    const friend = await u.user("べに");
    const other = await u.user("ちさ");
    await u.befriend(owner, friend);
    await u.befriend(owner, other);
    const create = async (startsAt: string, endsAt: string) => {
      const res = await u.call("POST", "/api/v1/broadcasts", { token: owner.token, body: { recipientIds: [friend.id, other.id], startsAt, endsAt } });
      expect(res.status).toBe(201);
      return ((await res.json()) as { id: string }).id;
    };
    const ended = await create(T("11:00"), T("13:00"));
    const later = await create(T("11:00", "12"), T("13:00", "12"));
    expect((await u.call("POST", `/api/v1/broadcasts/${ended}/responses`, { token: friend.token })).status).toBeLessThan(300);
    expect((await u.call("POST", `/api/v1/broadcasts/${ended}/decide`, { token: owner.token })).status).toBe(200);
    const meetupId = (await env.DB.prepare("SELECT id FROM meetups WHERE broadcast_id = ?1").bind(ended).first<{ id: string }>())?.id ?? "";
    expect(meetupId).not.toBe("");
    await icsLink(friend, meetupId);
    await attachPreview("broadcast_id", ended);

    await advanceTo(ms("13:00") + RETENTION_MS, owner, friend, other);
    await cleanupExpired(h.ctx);
    expect(await count("broadcasts WHERE id = ?1", ended)).toBe(1);

    await advanceTo(ms("13:00") + RETENTION_MS + 1, owner, friend, other);
    await cleanupExpired(h.ctx);
    expect(await count("broadcasts WHERE id = ?1", ended)).toBe(0);
    expect(await count("broadcasts WHERE id = ?1", later)).toBe(1);
    expect(await count("broadcast_recipients WHERE broadcast_id = ?1", ended)).toBe(0);
    expect(await count("meetups WHERE id = ?1", meetupId)).toBe(0);
    expect(await count("meetup_participants WHERE meetup_id = ?1", meetupId)).toBe(0);
    expect(await count("ics_tokens WHERE meetup_id = ?1", meetupId)).toBe(0);
    expect(await count("link_preview_refs WHERE broadcast_id = ?1", ended)).toBe(0);
    for (const who of [owner, friend, other]) {
      expect((await u.call("GET", `/api/v1/broadcasts/${ended}`, { token: who.token })).status).toBe(404);
      expect((await u.call("GET", `/api/v1/meetups/${meetupId}`, { token: who.token })).status).toBe(404);
      // 一覧からも消える（30日以内の募集は残る）
      for (const box of ["sent", "received"]) {
        const page = await u.call("GET", `/api/v1/broadcasts?box=${box}`, { token: who.token });
        expect(page.status).toBe(200);
        const text = JSON.stringify(await page.json());
        expect(text).not.toContain(ended);
        // 一覧自体は読めている（30日以内の募集は出る）
        if ((who === owner) === (box === "sent")) expect(text).toContain(later);
      }
      const meetups = await u.call("GET", "/api/v1/meetups", { token: who.token });
      expect(JSON.stringify(await meetups.json())).not.toContain(meetupId);
    }
  });
});

describe("お知らせ", () => {
  it("作ってからちょうど30日の行は残り、それより前の行は消える", async () => {
    const a = await u.user();
    expect(NOTIFICATION_RETENTION_MS).toBe(30 * DAY);
    const insert = async (insertedAt: number) => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO notifications (id, user_id, kind, event_id, created_at, inserted_at) VALUES (?1, ?2, 'invite_received', ?3, ?4, ?4)",
      )
        .bind(id, a.id, crypto.randomUUID(), insertedAt)
        .run();
      return id;
    };
    const kept = await insert(h.clock.now - 30 * DAY);
    await insert(h.clock.now - 30 * DAY - 1);
    await cleanupExpired(h.ctx);
    const left = await env.DB.prepare("SELECT id FROM notifications WHERE user_id = ?1").bind(a.id).all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([kept]);
  });
});

describe("流れないままの通知の記録", () => {
  async function seed(type: string, createdAt: number, processedAt: number | null = null) {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at, processed_at) VALUES (?1, ?2, '{}', ?3, ?4)")
      .bind(id, type, createdAt, processedAt)
      .run();
    return id;
  }
  const exists = async (id: string) => (await count("outbox WHERE id = ?1", id)) === 1;

  it("NOTIFICATION_START_AT が未設定の間だけ、通知だけの型の未処理で30日より前の行を消す。ほかの型・ちょうど30日は残す", async () => {
    const now = h.clock.now;
    const old = await seed("DirectInviteDeclined", now - RETENTION_MS - 1);
    const exact = await seed("DirectInviteDeclined", now - RETENTION_MS);
    const calendar = await seed("MeetupLeft", now - RETENTION_MS - 1);
    // 設定されていれば消さない
    await cleanupExpired(h.ctx);
    expect(await exists(old)).toBe(true);

    const unset = { env: { ...h.bindings, NOTIFICATION_START_AT: "" }, deps: h.deps };
    await cleanupExpired(unset);
    expect(await exists(old)).toBe(false);
    expect(await exists(exact)).toBe(true);
    expect(await exists(calendar)).toBe(true);
  });
});

describe("招待リンク", () => {
  it("期限からちょうど30日の行は残り、それより前の行は消える。消えたリンクの無効化は404", async () => {
    const a = await u.user();
    const res = await u.call("POST", "/api/v1/invite-links", { token: a.token, body: {} });
    const link = (await res.json()) as { id: string; expiresAt: string };
    const expiresAt = Date.parse(link.expiresAt);
    await advanceTo(expiresAt + RETENTION_MS, a);
    await cleanupExpired(h.ctx);
    expect((await u.call("POST", `/api/v1/invite-links/${link.id}/revoke`, { token: a.token })).status).toBe(204);
    await advanceTo(expiresAt + RETENTION_MS + 1, a);
    await cleanupExpired(h.ctx);
    expect(await count("invite_links WHERE id = ?1", link.id)).toBe(0);
    expect((await u.call("POST", `/api/v1/invite-links/${link.id}/revoke`, { token: a.token })).status).toBe(404);
  });
});

describe("くり返しの例外", () => {
  it("UTC の今日の2日前の日付より前の例外を消す（当日・翌日・翌々日は残る）。ルールは残る", async () => {
    const a = await u.user();
    const ruleId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO recurrence_rules (id, user_id, weekday, start_minute, end_minute, label, timezone, created_at) VALUES (?1, ?2, 6, 600, 840, NULL, 'Asia/Tokyo', 0)",
    )
      .bind(ruleId, a.id)
      .run();
    expect(exceptionCutoffDate(h.clock.now)).toBe("2026-10-08");
    await env.DB.batch(
      ["2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-17"].map((d) =>
        env.DB.prepare("INSERT INTO recurrence_exceptions (rule_id, local_date, created_at) VALUES (?1, ?2, 0)").bind(ruleId, d),
      ),
    );
    await cleanupExpired(h.ctx);
    const left = await env.DB.prepare("SELECT local_date FROM recurrence_exceptions WHERE rule_id = ?1 ORDER BY local_date")
      .bind(ruleId)
      .all<{ local_date: string }>();
    expect(left.results.map((r) => r.local_date)).toEqual(["2026-10-08", "2026-10-09", "2026-10-10", "2026-10-17"]);
    expect(await count("recurrence_rules WHERE id = ?1", ruleId)).toBe(1);
  });
});

describe("公開設定のマイグレーション", () => {
  it("友達でない相手との「見せる」の行だけが消え、「見せない」の行と友達との行は残る", async () => {
    const [a, b, c, d] = [await u.user("A"), await u.user("B"), await u.user("C"), await u.user("D")];
    await u.befriend(a, b);
    // 片方向だけの友達の行（どちらかの向きがあれば消さない）
    await env.DB.prepare("INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, 0)").bind(c.id, d.id).run();
    const policy = (owner: User, target: User, visible: number) =>
      env.DB.prepare("INSERT INTO sharing_policies (owner_id, target_id, visible, updated_at) VALUES (?1, ?2, ?3, 0)").bind(owner.id, target.id, visible);
    await env.DB.batch([
      policy(a, b, 1), // 友達
      policy(b, a, 0), // 友達
      policy(a, c, 1), // 友達でない「見せる」→ 消える
      policy(c, a, 0), // 友達でない「見せない」→ 残る
      policy(d, c, 1), // 片方向の友達の行がある → 残る
    ]);
    const statement = migration.slice(migration.indexOf("DELETE FROM sharing_policies"));
    await env.DB.prepare(statement).run();
    const rows = await env.DB.prepare(
      "SELECT owner_id, target_id FROM sharing_policies WHERE owner_id IN (SELECT value FROM json_each(?1)) ORDER BY owner_id, target_id",
    )
      .bind(JSON.stringify([a.id, b.id, c.id, d.id]))
      .all<{ owner_id: string; target_id: string }>();
    const key = (o: User, t: User) => `${o.id}>${t.id}`;
    expect(rows.results.map((r) => `${r.owner_id}>${r.target_id}`).sort()).toEqual([key(a, b), key(b, a), key(c, a), key(d, c)].sort());
  });
});

describe("プッシュの購読（15分ごと）", () => {
  it("失効か期限切れのセッションの購読が消え（利用者の最初のセッションの分も）、使えるセッションの購読は残る", async () => {
    const a = await u.user();
    const now = h.clock.now;
    const first = (await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ?1").bind(a.id).first<{ id: string }>())?.id ?? "";
    const expired = crypto.randomUUID();
    const active = crypto.randomUUID();
    await env.DB.batch([
      // 最初のセッション（セッションの掃除では残る行）を失効させる
      env.DB.prepare("UPDATE sessions SET revoked_at = ?2 WHERE id = ?1").bind(first, now - 40 * DAY),
      env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?3)").bind(expired, a.id, now),
      env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)").bind(active, a.id, now, now + DAY),
    ]);
    const sub = (sessionId: string) =>
      env.DB.prepare("INSERT INTO push_subscriptions (id, user_id, session_id, endpoint_hash, endpoint_enc, created_at) VALUES (?1, ?2, ?3, ?4, 'enc', ?5)").bind(
        crypto.randomUUID(),
        a.id,
        sessionId,
        `h-${crypto.randomUUID()}`,
        now,
      );
    await env.DB.batch([sub(first), sub(expired), sub(active)]);
    await runScheduled("*/15 * * * *", h.bindings, h.deps);
    const left = await env.DB.prepare("SELECT session_id FROM push_subscriptions WHERE user_id = ?1").bind(a.id).all<{ session_id: string }>();
    expect(left.results.map((r) => r.session_id)).toEqual([active]);
  });
});

describe("上限と cleanup_capped", () => {
  beforeEach(async () => {
    await env.DB.batch(
      ["direct_invites", "broadcasts", "notifications", "invite_links", "recurrence_exceptions", "outbox", "push_subscriptions"].map((t) =>
        env.DB.prepare(`DELETE FROM ${t}`),
      ),
    );
  });

  /** 入れた行を数える条件（ログインで書かれる outbox の行は数えない） */
  const SEEDED = [
    "direct_invites",
    "broadcasts",
    "notifications",
    "invite_links",
    "recurrence_exceptions",
    "outbox WHERE type = 'BroadcastSent'",
    "push_subscriptions",
  ];

  async function seed(n: number, make: (i: number) => D1PreparedStatement) {
    for (let i = 0; i < n; i += 500) {
      await env.DB.batch(Array.from({ length: Math.min(500, n - i) }, (_, k) => make(i + k)));
    }
  }

  async function seedAll(owner: string, sessionId: string, ruleId: string) {
    const old = h.clock.now - RETENTION_MS - DAY;
    await seed(CLEANUP_BATCH + 1, () =>
      env.DB.prepare(
        "INSERT INTO direct_invites (id, sender_id, recipient_id, kind, starts_at, ends_at, status, expires_at, created_at) VALUES (?1, ?2, ?2, 'kokodou', ?3, ?3, 'pending', ?3, ?3)",
      ).bind(crypto.randomUUID(), owner, old),
    );
    await seed(BROADCAST_CLEANUP_BATCH + 1, () =>
      env.DB.prepare(
        "INSERT INTO broadcasts (id, owner_id, starts_at, ends_at, status, expires_at, created_at) VALUES (?1, ?2, ?3, ?3, 'open', ?3, ?3)",
      ).bind(crypto.randomUUID(), owner, old),
    );
    await seed(NOTIFICATION_CLEANUP_BATCH + 1, () =>
      env.DB.prepare(
        "INSERT INTO notifications (id, user_id, kind, event_id, created_at, inserted_at) VALUES (?1, ?2, 'invite_received', ?1, ?3, ?3)",
      ).bind(crypto.randomUUID(), owner, old),
    );
    await seed(CLEANUP_BATCH + 1, () =>
      env.DB.prepare(
        "INSERT INTO invite_links (id, owner_id, token_hash, max_uses, uses, expires_at, created_at) VALUES (?1, ?2, ?1, 1, 0, ?3, ?3)",
      ).bind(crypto.randomUUID(), owner, old),
    );
    await seed(CLEANUP_BATCH + 1, (i) =>
      env.DB.prepare("INSERT INTO recurrence_exceptions (rule_id, local_date, created_at) VALUES (?1, ?2, 0)").bind(
        ruleId,
        new Date(Date.parse("2020-01-01T00:00:00Z") + i * DAY).toISOString().slice(0, 10),
      ),
    );
    await seed(CLEANUP_BATCH + 1, () =>
      env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at) VALUES (?1, 'BroadcastSent', '{}', ?2)").bind(crypto.randomUUID(), old),
    );
    await seed(PUSH_SUBSCRIPTION_CLEANUP_BATCH + 1, () =>
      env.DB.prepare(
        "INSERT INTO push_subscriptions (id, user_id, session_id, endpoint_hash, endpoint_enc, created_at) VALUES (?1, ?2, ?3, ?1, 'enc', 0)",
      ).bind(crypto.randomUUID(), owner, sessionId),
    );
  }

  it("誘い1000・募集100・お知らせ1000・ほか1000行（購読は1000行）まで処理し、上限いっぱいなら cleanup_capped。残りは次の実行で", async () => {
    const a = await u.user();
    const sessionId = (await env.DB.prepare("SELECT id FROM sessions WHERE user_id = ?1").bind(a.id).first<{ id: string }>())?.id ?? "";
    await env.DB.prepare("UPDATE sessions SET revoked_at = ?2 WHERE id = ?1").bind(sessionId, h.clock.now).run();
    const ruleId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO recurrence_rules (id, user_id, weekday, start_minute, end_minute, label, timezone, created_at) VALUES (?1, ?2, 6, 600, 840, NULL, 'Asia/Tokyo', 0)",
    )
      .bind(ruleId, a.id)
      .run();
    await seedAll(a.id, sessionId, ruleId);
    expect([CLEANUP_BATCH, BROADCAST_CLEANUP_BATCH, NOTIFICATION_CLEANUP_BATCH, PUSH_SUBSCRIPTION_CLEANUP_BATCH]).toEqual([1000, 100, 1000, 1000]);

    const unset = { env: { ...h.bindings, NOTIFICATION_START_AT: "" }, deps: h.deps };
    await cleanupExpired(unset);
    await runScheduled("*/15 * * * *", unset.env, h.deps);
    const capped = events("cleanup_capped");
    expect(capped).toEqual(
      expect.arrayContaining([
        { event: "cleanup_capped", step: "cleanup_notifications", count: 1000 },
        { event: "cleanup_capped", step: "cleanup_invitations", count: 1000 },
        { event: "cleanup_capped", step: "cleanup_broadcasts", count: 100 },
        { event: "cleanup_capped", step: "cleanup_invite_links", count: 1000 },
        { event: "cleanup_capped", step: "cleanup_recurrence_exceptions", count: 1000 },
        { event: "cleanup_capped", step: "cleanup_stale_notification_outbox", count: 1000 },
        { event: "cleanup_capped", step: "cleanup_push_subscriptions", count: 1000 },
      ]),
    );
    expect(capped).toHaveLength(7);
    for (const t of SEEDED) expect(await count(t), t).toBe(1);
    // ログには件数と step だけ（ID は出さない）
    expect(logs.join("\n")).not.toContain(a.id);

    logs.length = 0;
    await cleanupExpired(unset);
    await runScheduled("*/15 * * * *", unset.env, h.deps);
    expect(events("cleanup_capped")).toEqual([]);
    for (const t of SEEDED) expect(await count(t), t).toBe(0);
  });
});
