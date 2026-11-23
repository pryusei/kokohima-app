import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookieValue, createHarness } from "../../test/identity-harness";
import { makeUsers, type User } from "../../test/users";
import { handleJob } from "../jobs/consumer";
import { runScheduled } from "../worker";
import * as identityRepo from "../identity/infra/repository";
import { DORMANCY_BATCH, DORMANT_AFTER_MS, wakeConnectionsStatement } from "./application/dormancy";
import { assignSyncs, syncConnection } from "./application/sync";
import * as repo from "./infra/repository";

// 休眠中の連携（docs/specs/T-17-retention.md「8.」）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;
let logs: string[];

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  // 件数と割り当てで確かめるので、前のテストの連携を消しておく（このファイルの中ではストレージが共有される）
  await env.DB.prepare("DELETE FROM calendar_connections").run();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const T = (s: string, day = "10") => `2026-10-${day}T${s}:00.000Z`;
const busy = (start: string, end: string) => ({ start, end });
const CRON_15 = "*/15 * * * *";

const events = (name: string) =>
  logs.flatMap((l) => {
    try {
      const o = JSON.parse(l) as { event?: string };
      return o.event === name ? [o as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

/** sub を覚えておき、あとで同じ人としてログインし直せる利用者 */
async function person(name = "あき") {
  const sub = `sub-${crypto.randomUUID()}`;
  const r = await h.login("google", sub);
  expect((await u.call("PATCH", "/api/v1/me", { token: r.accessToken, body: { displayName: name } })).status).toBe(200);
  const me = (await (await u.call("GET", "/api/v1/me", { token: r.accessToken })).json()) as { id: string };
  return { id: me.id, token: r.accessToken, refreshToken: r.refreshToken, name, sub } satisfies User & { sub: string };
}

async function connect(who: User) {
  const res = await u.call("POST", "/api/v1/calendar/google/authorizations", { token: who.token });
  expect(res.status).toBe(200);
  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
  const binding = cookieValue(res, "__Host-kh_cal") ?? "";
  const cb = await h.request(`/api/v1/calendar/google/callback?${new URLSearchParams({ code: "auth-code", state })}`, {
    headers: { Cookie: `__Host-kh_cal=${binding}` },
  });
  expect(cb.headers.get("Location")).toBe("https://app.test/settings/calendar?calendar=connected");
}

/** 連携して最初の確認（記録だけ）を終える。その前に作った枠が「前回の確認より前」になるよう1分進める */
async function synced(who: User) {
  await u.advance(MIN, who);
  await connect(who);
  expect(await syncConnection(h.ctx, who.id, "google")).toBe("recorded");
}

const row = (who: { id: string }) =>
  env.DB.prepare("SELECT * FROM calendar_connections WHERE user_id = ?1 AND provider = 'google'")
    .bind(who.id)
    .first<repo.ConnectionRow>();

const manualCount = async (who: { id: string }) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM availabilities WHERE user_id = ?1").bind(who.id).first<{ n: number }>())?.n;

const cancelEvents = async (who: { id: string }) =>
  (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'AvailabilityCancelledByCalendar' AND payload LIKE ?1")
      .bind(`%${who.id}%`)
      .first<{ n: number }>()
  )?.n;

/** その人のセッションを、ログアウトした状態にし、最後に使った時刻を lastUsedAt にする（使える更新用トークンがなくなる） */
async function abandon(who: { id: string }, lastUsedAt: number) {
  await env.DB.prepare("UPDATE sessions SET revoked_at = ?2, last_used_at = ?3 WHERE user_id = ?1")
    .bind(who.id, h.clock.now, lastUsedAt)
    .run();
}

const assigned = (who: { id: string }) => h.jobs.some((j) => j.kind === "calendar_sync" && j.userId === who.id);

/** 割り当ての対象になるよう、最後の確認を十分前にする */
const makeDue = (who: { id: string }) =>
  env.DB.prepare("UPDATE calendar_connections SET last_synced_at = ?2 WHERE user_id = ?1").bind(who.id, h.clock.now - DAY).run();

describe("休眠にする", () => {
  it("使える更新用トークンがなく、最後に使ってから30日を過ぎると休眠になり、埋まりの記録・権利・sync_id が変わり、割り当てられない", async () => {
    const a = await person();
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    await synced(a);
    const before = await row(a);
    expect(before?.busy_snapshot).not.toBeNull();
    await env.DB.prepare("UPDATE calendar_connections SET sync_lease_until = ?2, large_change_held = 1 WHERE user_id = ?1")
      .bind(a.id, h.clock.now + MIN)
      .run();

    // ちょうど30日前に使った人は休眠にならない
    await abandon(a, h.clock.now - DORMANT_AFTER_MS);
    await runScheduled(CRON_15, h.bindings, h.deps);
    expect((await row(a))?.dormant_since).toBeNull();

    await abandon(a, h.clock.now - DORMANT_AFTER_MS - 1);
    await makeDue(a);
    h.jobs.length = 0;
    await runScheduled(CRON_15, h.bindings, h.deps);
    const after = await row(a);
    expect(after).toMatchObject({
      status: "active",
      dormant_since: h.clock.now,
      busy_snapshot: null,
      snapshot_from: null,
      snapshot_to: null,
      last_synced_at: null,
      large_change_held: 0,
      sync_lease_until: null,
      updated_at: h.clock.now,
      // 更新用トークンと calendar_id は残す
      refresh_token_enc: before?.refresh_token_enc,
      calendar_id: before?.calendar_id,
    });
    expect(after?.sync_id).not.toBeNull();
    expect(after?.sync_id).not.toBe(before?.sync_id);
    // 同じ実行の割り当てにも、次の割り当てにも入らない
    expect(assigned(a)).toBe(false);
    await assignSyncs(h.ctx);
    expect(assigned(a)).toBe(false);
    expect(events("cleanup_capped")).toEqual([]);
  });

  it("休眠にしない：トークンが使える人・ログアウトしただけの人・セッションの期限で切れたが最近使った人・退会した人", async () => {
    const usable = await person("つかえる");
    const loggedOut = await person("ログアウト");
    const expired = await person("期限");
    const withdrawn = await person("退会");
    for (const p of [usable, loggedOut, expired, withdrawn]) await connect(p);
    const old = h.clock.now - DORMANT_AFTER_MS - 1;
    // トークンは使える（最後に使った時刻だけが古い）
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?2 WHERE user_id = ?1").bind(usable.id, old).run();
    // ログアウトしただけで、最後に使ってから30日以内
    expect((await h.request("/api/v1/auth/logout", { method: "POST", headers: { Origin: "https://app.test", Cookie: `__Host-kh_rt=${loggedOut.refreshToken}` } })).status).toBeLessThan(300);
    // セッションの期限（90日）で切れたが、最後に使ってから30日以内
    await env.DB.prepare("UPDATE sessions SET expires_at = ?2, last_used_at = ?3 WHERE user_id = ?1")
      .bind(expired.id, h.clock.now, h.clock.now - 10 * DAY)
      .run();
    // 退会した人（後始末の段の前）
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET withdrawn_at = ?2 WHERE id = ?1").bind(withdrawn.id, h.clock.now),
      env.DB.prepare("UPDATE sessions SET revoked_at = ?2, last_used_at = ?3 WHERE user_id = ?1").bind(withdrawn.id, h.clock.now, old),
    ]);
    h.clock.now += DAY;
    await runScheduled(CRON_15, h.bindings, h.deps);
    for (const p of [usable, loggedOut, expired, withdrawn]) expect((await row(p))?.dormant_since, p.name).toBeNull();
  });
});

describe("休眠にした後に届いた確認", () => {
  const busyResponse = () => Response.json({ calendars: { primary: { busy: h.google.state.busy } } });
  const markDormant = () => repo.markDormantConnections(env.DB, h.clock.now, h.clock.now - DORMANT_AFTER_MS, DORMANCY_BATCH);
  /** 権利（sync_lease_until・sync_id）は変えず、休眠の印だけを立てる（dormant_since IS NULL の条件そのものを確かめる） */
  const flagOnly = (who: { id: string }) =>
    env.DB.prepare("UPDATE calendar_connections SET dormant_since = ?1 WHERE user_id = ?2").bind(h.clock.now, who.id).run();

  /** 取り消しが20を超える準備：21日分のここ暇と、それをすべて覆う埋まり */
  async function manyNights(who: User) {
    for (let d = 11; d <= 31; d++) {
      const date = `2026-10-${String(d).padStart(2, "0")}`;
      expect((await u.call("POST", "/api/v1/availabilities", { token: who.token, body: { date, preset: "night" } })).status).toBe(201);
    }
  }

  it("休眠にする前に権利を取っていた確認は、記録を書かず取り消しもしない", async () => {
    const a = await person();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await synced(a);
    await u.advance(15 * MIN, a);
    await abandon(a, h.clock.now - DORMANT_AFTER_MS - 1);
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    // freeBusy の応答の間に休眠になる
    h.google.state.freeBusyOverride = async () => {
      expect(await markDormant()).toBe(1);
      return busyResponse();
    };
    await syncConnection(h.ctx, a.id, "google");
    h.google.state.freeBusyOverride = null;
    const after = await row(a);
    expect(after?.dormant_since).toBe(h.clock.now);
    expect(after?.busy_snapshot).toBeNull();
    expect(after?.last_synced_at).toBeNull();
    expect(await manualCount(a)).toBe(1);
    expect(await cancelEvents(a)).toBe(0);
  });

  it("権利はそのままでも、休眠の印だけで記録を進めず取り消さない（advanceSnapshotStatement の dormant_since IS NULL）", async () => {
    const a = await person();
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await synced(a);
    await u.advance(15 * MIN, a);
    const before = await row(a);
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    let during: repo.ConnectionRow | null = null;
    h.google.state.freeBusyOverride = async () => {
      await flagOnly(a);
      during = await row(a);
      return busyResponse();
    };
    await syncConnection(h.ctx, a.id, "google");
    h.google.state.freeBusyOverride = null;
    const after = await row(a);
    // 割り込みは権利を変えていない
    expect(during!.sync_lease_until).not.toBeNull();
    expect(during!.sync_id).toBe(before?.sync_id);
    expect(after?.busy_snapshot).toBe(before?.busy_snapshot);
    expect(after?.last_synced_at).toBe(before?.last_synced_at);
    expect(after?.sync_id).toBe(before?.sync_id);
    expect(await manualCount(a)).toBe(1);
    expect(await cancelEvents(a)).toBe(0);
  });

  it("休眠にした後に権利を取ろうとした確認は skipped", async () => {
    const a = await person();
    await synced(a);
    await abandon(a, h.clock.now - DORMANT_AFTER_MS - 1);
    await runScheduled(CRON_15, h.bindings, h.deps);
    const dormant = await row(a);
    expect(dormant?.dormant_since).not.toBeNull();
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("skipped");
    expect(await row(a)).toEqual(dormant);
  });

  it("保留の1回目（取り消しが多すぎる）も、休眠にした後は書かない。sync_id は休眠にしたときの値のまま", async () => {
    const a = await person();
    await manyNights(a);
    await synced(a);
    await u.advance(15 * MIN, a);
    await abandon(a, h.clock.now - DORMANT_AFTER_MS - 1);
    h.google.state.busy = [busy(T("00:00", "11"), "2026-11-01T00:00:00.000Z")];
    let marked: repo.ConnectionRow | null = null;
    h.google.state.freeBusyOverride = async () => {
      expect(await markDormant()).toBe(1);
      marked = await row(a);
      return busyResponse();
    };
    await syncConnection(h.ctx, a.id, "google");
    h.google.state.freeBusyOverride = null;
    const after = await row(a);
    expect(after?.dormant_since).not.toBeNull();
    expect(after?.large_change_held).toBe(0);
    expect(after?.sync_id).toBe(marked!.sync_id);
    expect(await manualCount(a)).toBe(21);
    expect(await cancelEvents(a)).toBe(0);
  });

  it("権利はそのままでも、休眠の印だけで保留を書かない（holdLargeChange の dormant_since IS NULL）", async () => {
    const a = await person();
    await manyNights(a);
    await synced(a);
    await u.advance(15 * MIN, a);
    const before = await row(a);
    h.google.state.busy = [busy(T("00:00", "11"), "2026-11-01T00:00:00.000Z")];
    h.google.state.freeBusyOverride = async () => {
      await flagOnly(a);
      return busyResponse();
    };
    await syncConnection(h.ctx, a.id, "google");
    h.google.state.freeBusyOverride = null;
    const after = await row(a);
    expect(after?.large_change_held).toBe(0);
    expect(after?.sync_id).toBe(before?.sync_id);
    expect(after?.busy_snapshot).toBe(before?.busy_snapshot);
    expect(await manualCount(a)).toBe(21);
    expect(await cancelEvents(a)).toBe(0);
  });
});

describe("戻す", () => {
  it("ログインでセッションを作ると、同じ batch で戻り、次の確認は記録だけ（ここ暇を取り消さない）。ほかの人の連携は変わらない", async () => {
    const a = await person();
    const b = await person("べに");
    await u.call("POST", "/api/v1/availabilities", { token: a.token, body: { date: "2026-10-11", preset: "night" } });
    await synced(a);
    await connect(b);
    await abandon(a, h.clock.now - DORMANT_AFTER_MS - 1);
    await abandon(b, h.clock.now - DORMANT_AFTER_MS - 1);
    await runScheduled(CRON_15, h.bindings, h.deps);
    const dormant = await row(a);
    expect(dormant?.dormant_since).not.toBeNull();
    const bDormant = await row(b);
    expect(bDormant?.dormant_since).not.toBeNull();

    h.clock.now += MIN;
    await h.login("google", a.sub);
    const woken = await row(a);
    expect(woken).toMatchObject({
      dormant_since: null,
      busy_snapshot: null,
      snapshot_from: null,
      snapshot_to: null,
      last_synced_at: null,
      large_change_held: 0,
      sync_lease_until: null,
      updated_at: h.clock.now,
    });
    expect(woken?.sync_id).not.toBe(dormant?.sync_id);
    expect(await row(b)).toEqual(bDormant);

    // 休眠の間に入った予定でも、まとめて取り消さない
    h.google.state.busy = [busy(T("11:00", "11"), T("12:00", "11"))];
    expect(await syncConnection(h.ctx, a.id, "google")).toBe("recorded");
    expect(await manualCount(a)).toBe(1);
    expect(await cancelEvents(a)).toBe(0);
  });

  it("セッションができなかったとき（退会した人）は戻さない", async () => {
    const a = await person();
    await connect(a);
    await env.DB.batch([
      env.DB.prepare("UPDATE calendar_connections SET dormant_since = ?2 WHERE user_id = ?1").bind(a.id, h.clock.now),
      env.DB.prepare("UPDATE users SET withdrawn_at = ?2 WHERE id = ?1").bind(a.id, h.clock.now),
    ]);
    const sessionId = crypto.randomUUID();
    const created = await identityRepo.createSessionRows(identityRepo.db(env.DB), {
      sessionId,
      userId: a.id,
      tokenHash: `x-${sessionId}`,
      tokenExpiresAt: h.clock.now + DAY,
      sessionExpiresAt: h.clock.now + DAY,
      event: { userId: a.id },
      now: h.clock.now,
      afterSession: [wakeConnectionsStatement(env.DB, a.id, sessionId, h.clock.now)],
    });
    expect(created).toBe(false);
    expect((await row(a))?.dormant_since).toBe(h.clock.now);
  });

  it("15分ごとの実行で、使えるトークンがあり最後に使ってから30日以内の休眠の連携を戻す。片方だけ当てはまる連携は変わらない", async () => {
    const both = await person("両方");
    const tokenOnly = await person("トークンだけ");
    const recentOnly = await person("最近だけ");
    for (const p of [both, tokenOnly, recentOnly]) {
      await connect(p);
      await env.DB.prepare("UPDATE calendar_connections SET dormant_since = ?2 WHERE user_id = ?1").bind(p.id, h.clock.now - DAY).run();
    }
    // トークンは使えるが、最後に使ったのは30日より前
    await env.DB.prepare("UPDATE sessions SET last_used_at = ?2 WHERE user_id = ?1")
      .bind(tokenOnly.id, h.clock.now - DORMANT_AFTER_MS - 1)
      .run();
    // 最近使ったが、ログアウトしてトークンがない
    await abandon(recentOnly, h.clock.now - DAY);
    const before = { tokenOnly: await row(tokenOnly), recentOnly: await row(recentOnly) };
    h.clock.now += MIN;
    await runScheduled(CRON_15, h.bindings, h.deps);
    expect(await row(both)).toMatchObject({ dormant_since: null, busy_snapshot: null, last_synced_at: null, updated_at: h.clock.now });
    expect(await row(tokenOnly)).toEqual(before.tokenOnly);
    expect(await row(recentOnly)).toEqual(before.recentOnly);
    // 戻した連携は、同じ実行で割り当てられる（last_synced_at が NULL）
    expect(assigned(both)).toBe(true);
  });

  it("連携し直すと休眠が外れる", async () => {
    const a = await person();
    await synced(a);
    await env.DB.prepare("UPDATE calendar_connections SET dormant_since = ?2 WHERE user_id = ?1").bind(a.id, h.clock.now).run();
    await connect(a);
    expect((await row(a))?.dormant_since).toBeNull();
  });
});

describe("休眠中も止まらないもの", () => {
  it("成立した予定は、休眠中の人のカレンダーにも書く", async () => {
    const a = await person();
    const b = await person("べに");
    await connect(a);
    await env.DB.prepare("UPDATE calendar_connections SET dormant_since = ?2 WHERE user_id = ?1").bind(a.id, h.clock.now).run();
    await u.befriend(b, a);
    const sent = await u.call("POST", "/api/v1/direct-invites", {
      token: b.token,
      body: { recipientId: a.id, startsAt: T("11:00", "11"), endsAt: T("13:00", "11") },
    });
    const inviteId = ((await sent.json()) as { id: string }).id;
    const accepted = await u.call("POST", `/api/v1/direct-invites/${inviteId}/responses`, {
      token: a.token,
      body: { response: "accept" },
    });
    const meetupId = ((await accepted.json()) as { meetupId: string }).meetupId;
    const ev = await env.DB.prepare("SELECT id, payload FROM outbox WHERE type = 'MeetupConfirmed' AND payload LIKE ?1")
      .bind(`%${meetupId}%`)
      .first<{ id: string; payload: string }>();
    await handleJob(h.ctx, { kind: "outbox", id: ev?.id ?? "", type: "MeetupConfirmed", payload: ev?.payload ?? "{}" });
    expect(h.google.liveEvents()).toHaveLength(1);
    expect((await row(a))?.dormant_since).toBe(h.clock.now);
  });
});

describe("上限", () => {
  async function seedConnections(n: number, dormantSince: number | null) {
    const ids = Array.from({ length: n }, () => crypto.randomUUID());
    await env.DB.batch(
      ids.flatMap((id) => [
        env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?1, 0, 0)").bind(id),
        env.DB.prepare(
          "INSERT INTO calendar_connections (user_id, provider, status, connected_at, updated_at, dormant_since) VALUES (?1, 'google', 'active', 0, 0, ?2)",
        ).bind(id, dormantSince),
      ]),
    );
    return ids;
  }

  it("休眠にするのは1回に100行まで。上限いっぱいなら cleanup_capped を出し、残りは次の実行で", async () => {
    // セッションの行がない人は、最後に使ってから30日を過ぎている
    await seedConnections(DORMANCY_BATCH + 1, null);
    expect(DORMANCY_BATCH).toBe(100);
    await runScheduled(CRON_15, h.bindings, h.deps);
    expect(events("cleanup_capped")).toEqual([{ event: "cleanup_capped", step: "mark_dormant_connections", count: 100 }]);
    const left = async () =>
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_connections WHERE dormant_since IS NULL").first<{ n: number }>())?.n;
    expect(await left()).toBe(1);
    logs.length = 0;
    await runScheduled(CRON_15, h.bindings, h.deps);
    expect(await left()).toBe(0);
    expect(events("cleanup_capped")).toEqual([]);
  });

  it("戻すのも1回に100行まで", async () => {
    const ids = await seedConnections(DORMANCY_BATCH + 1, h.clock.now - DAY);
    await env.DB.batch(
      ids.flatMap((userId) => {
        const sessionId = crypto.randomUUID();
        return [
          env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?3, ?4)").bind(
            sessionId,
            userId,
            h.clock.now,
            h.clock.now + DAY,
          ),
          env.DB.prepare("INSERT INTO refresh_tokens (id, session_id, token_hash, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)").bind(
            crypto.randomUUID(),
            sessionId,
            `h-${sessionId}`,
            h.clock.now,
            h.clock.now + DAY,
          ),
        ];
      }),
    );
    await runScheduled(CRON_15, h.bindings, h.deps);
    expect(events("cleanup_capped")).toEqual([{ event: "cleanup_capped", step: "wake_dormant_connections", count: 100 }]);
    const dormant = await env.DB.prepare("SELECT COUNT(*) AS n FROM calendar_connections WHERE dormant_since IS NOT NULL").first<{ n: number }>();
    expect(dormant?.n).toBe(1);
  });
});
