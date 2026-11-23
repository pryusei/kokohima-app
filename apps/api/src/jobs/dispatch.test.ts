import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { fullScans, queryPlan, recordingD1 } from "../../test/query-plan";
import { makeUsers } from "../../test/users";
import * as availabilityRepo from "../availability/infra/repository";
import { assignSyncs, SYNC_BATCH } from "../calendar/application/sync";
import * as calendarRepo from "../calendar/infra/repository";
import * as linkPreviewRepo from "../link-preview/infra/repository";
import * as notificationRepo from "../notification/infra/repository";
import * as invitationRepo from "../invitation/infra/repository";
import * as broadcastRepo from "../invitation/infra/broadcastRepository";
import * as socialRepo from "../social/infra/repository";
import { DORMANCY_BATCH, DORMANT_AFTER_MS } from "../calendar/application/dormancy";
import { runScheduled } from "../worker";
import {
  AVAILABILITY_RETENTION_MS,
  BROADCAST_CLEANUP_BATCH,
  cleanupExpired,
  CLEANUP_BATCH,
  deleteProcessedOutbox,
  deleteStaleNotificationOutbox,
  dispatchOutbox,
  exceptionCutoffDate,
  OUTBOX_RETENTION_MS,
  RETENTION_MS,
} from "./dispatch";

// データの増加への備え（docs/specs/T-12-data-growth.md）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let logs: string[];
let warns: string[];

beforeEach(async () => {
  h = await createHarness();
  // 件数で確かめるので、前のテストの行を消しておく（このファイルの中ではストレージが共有される）
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM calendar_connections"),
    env.DB.prepare("DELETE FROM availabilities"),
  ]);
  logs = [];
  warns = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  // cron_step_failed は warn で出す（docs/specs/T-13-monitoring.md「3.」）
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
    logs.push(String(line));
    warns.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const events = (name: string) =>
  logs.flatMap((l) => {
    try {
      const o = JSON.parse(l) as { event?: string };
      return o.event === name ? [o as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

/** 処理する型（MeetupLeft）の未処理の行を n 件入れる */
async function seedOutbox(n: number, processedAt: number | null = null) {
  const ids = Array.from({ length: n }, () => crypto.randomUUID());
  for (let i = 0; i < n; i += 500) {
    await env.DB.batch(
      ids.slice(i, i + 500).map((id, k) =>
        env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at, processed_at) VALUES (?1, 'MeetupLeft', ?2, ?3, ?4)").bind(
          id,
          JSON.stringify({ meetupId: crypto.randomUUID() }),
          -100000 + i + k,
          processedAt,
        ),
      ),
    );
  }
  return ids;
}

const unprocessed = async () =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE processed_at IS NULL").first<{ n: number }>())?.n ?? 0;

async function seedUsers(n: number) {
  const ids = Array.from({ length: n }, () => crypto.randomUUID());
  for (let i = 0; i < n; i += 500) {
    await env.DB.batch(
      ids
        .slice(i, i + 500)
        .map((id) => env.DB.prepare("INSERT INTO users (id, created_at, updated_at) VALUES (?1, 0, 0)").bind(id)),
    );
  }
  return ids;
}

describe("outbox を繰り返し流す", () => {
  it("250件なら1回の実行で全部送り、処理済みにする。打ち切りのログは出ない", async () => {
    await seedOutbox(250);
    h.jobs.length = 0;
    expect(await dispatchOutbox(h.ctx)).toBe(250);
    expect(h.jobs).toHaveLength(250);
    expect(await unprocessed()).toBe(0);
    expect(events("outbox_dispatch_capped")).toEqual([]);
  });

  it("1500件なら1回の実行で1000件だけ送り、残りは次の実行で送る。件数だけのログを出す", async () => {
    await seedOutbox(1500);
    expect(await dispatchOutbox(h.ctx)).toBe(1000);
    expect(await unprocessed()).toBe(500);
    expect(events("outbox_dispatch_capped")).toEqual([{ event: "outbox_dispatch_capped", reason: "count", sent: 1000 }]);
    expect(await dispatchOutbox(h.ctx)).toBe(500);
    expect(await unprocessed()).toBe(0);
  });

  it("ちょうど1000件で未処理の行がなくなっても、10回目で止まったので count のログを出す", async () => {
    await seedOutbox(1000);
    expect(await dispatchOutbox(h.ctx)).toBe(1000);
    expect(events("outbox_dispatch_capped")[0]?.reason).toBe("count");
  });

  it("20秒を過ぎたら次の回に入らず、time のログを出す", async () => {
    await seedOutbox(1500);
    let t = h.clock.now;
    // 時刻を読むたびに6秒進む時計
    const slow = { env: h.bindings, deps: { ...h.deps, now: () => (t += 6000) } };
    const sent = await dispatchOutbox(slow);
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(1000);
    expect(sent % 100).toBe(0);
    expect(events("outbox_dispatch_capped")).toEqual([{ event: "outbox_dispatch_capped", reason: "time", sent }]);
  });
});

describe("処理済みの outbox の掃除", () => {
  it("処理済みで7日を過ぎた行だけを消す。7日以内と未処理の行は残す", async () => {
    const now = h.clock.now;
    const old = await seedOutbox(3, now - OUTBOX_RETENTION_MS - 1);
    const recent = await seedOutbox(2, now - OUTBOX_RETENTION_MS + 1);
    const pending = await seedOutbox(2, null);
    await cleanupExpired(h.ctx);
    const left = await env.DB.prepare("SELECT id FROM outbox WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(JSON.stringify([...old, ...recent, ...pending]))
      .all<{ id: string }>();
    expect(new Set(left.results.map((r) => r.id))).toEqual(new Set([...recent, ...pending]));
  });

  it("1回に消すのは上限まで", async () => {
    await seedOutbox(5, h.clock.now - OUTBOX_RETENTION_MS - 1);
    expect(await deleteProcessedOutbox(env.DB, h.clock.now - OUTBOX_RETENTION_MS, 3)).toBe(3);
    expect(await deleteProcessedOutbox(env.DB, h.clock.now - OUTBOX_RETENTION_MS, 3)).toBe(2);
    expect(CLEANUP_BATCH).toBe(1000);
  });
});

describe("カレンダーの確認の割り当て", () => {
  async function seedConnections(lastSynced: (i: number) => number | null, n: number) {
    const users = await seedUsers(n);
    for (let i = 0; i < n; i += 500) {
      await env.DB.batch(
        users.slice(i, i + 500).map((id, k) =>
          env.DB.prepare(
            "INSERT INTO calendar_connections (user_id, provider, status, connected_at, updated_at, last_synced_at) VALUES (?1, 'google', 'active', 0, 0, ?2)",
          ).bind(id, lastSynced(i + k)),
        ),
      );
    }
    return users;
  }

  it("1200人が対象なら1000人を送る。確認したことがない連携が先、次に古い順。上限で埋まったログを出す", async () => {
    // 最後の2人は確認したことがない。ほかは i が小さいほど古い
    const users = await seedConnections((i) => (i >= 1198 ? null : h.clock.now - DAY + i * 1000), 1200);
    h.jobs.length = 0;
    expect(await assignSyncs(h.ctx)).toBe(SYNC_BATCH);
    expect(SYNC_BATCH).toBe(1000);
    const sent = h.jobs.flatMap((j) => (j.kind === "calendar_sync" ? [j.userId] : []));
    expect(sent).toHaveLength(1000);
    expect(sent.slice(0, 2).sort()).toEqual([users[1198], users[1199]].sort());
    expect(sent.slice(2)).toEqual(users.slice(0, 998));
    expect(events("calendar_sync_assign_full")).toEqual([{ event: "calendar_sync_assign_full", assigned: 1000 }]);
  });

  it("999人なら全員を送り、ログは出ない", async () => {
    await seedConnections(() => null, 999);
    expect(await assignSyncs(h.ctx)).toBe(999);
    expect(events("calendar_sync_assign_full")).toEqual([]);
  });
});

describe("ここ暇の検索（開始日時の条件を足しても結果が変わらない）", () => {
  const from = Date.parse("2026-10-12T00:00:00Z");
  const to = Date.parse("2026-10-13T00:00:00Z");

  async function seedSlots(userId: string) {
    const slot = async (startsAt: number, endsAt: number) => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 0)",
      )
        .bind(id, userId, startsAt, endsAt)
        .run();
      return id;
    };
    return {
      // 24時間の枠で、範囲の始まりと1分だけ重なる（範囲の始まりの24時間前の直後に始まる）
      longEdge: await slot(from - DAY + MIN, from + MIN),
      // 範囲の始まりちょうどで終わる（重ならない）
      endsAtFrom: await slot(from - 2 * HOUR, from),
      // 範囲の終わりちょうどに始まる（重ならない）
      startsAtTo: await slot(to, to + HOUR),
      inside: await slot(from + HOUR, from + 3 * HOUR),
    };
  }

  it("自分の一覧と自動取り消しの対象：境界の枠が正しく入る・入らない", async () => {
    const u = makeUsers(h);
    const a = await u.user("あき");
    const s = await seedSlots(a.id);
    const now = h.clock.now;
    const mine = await availabilityRepo.listMyManual(env.DB, a.id, from, to, now);
    expect(mine.map((r) => r.id).sort()).toEqual([s.longEdge, s.inside].sort());
    const facing = await availabilityRepo.myManualWithCreatedAt(env.DB, a.id, from, to, now);
    expect(facing.map((r) => r.id).sort()).toEqual([s.longEdge, s.inside].sort());
  });

  it("友達の空き：境界の枠が正しく入り、友達でない人の枠は入らない", async () => {
    const u = makeUsers(h);
    const a = await u.user("あき");
    const b = await u.user("べに");
    const c = await u.user("ちか");
    await u.befriend(a, b);
    const s = await seedSlots(a.id);
    await seedSlots(c.id);
    const seen = await availabilityRepo.visibleManual(env.DB, b.id, { from, to, now: h.clock.now });
    expect(seen.map((r) => r.id).sort()).toEqual([s.longEdge, s.inside].sort());
    const one = await availabilityRepo.visibleManual(env.DB, b.id, { from, to, now: h.clock.now }, c.id);
    expect(one).toEqual([]);
  });

  it("追加：24時間前から続く自分の枠と重なれば追加しない。重ならなければ追加する", async () => {
    const u = makeUsers(h);
    const a = await u.user("あき");
    await seedSlots(a.id);
    const insert = (startsAt: number, endsAt: number) =>
      availabilityRepo.insertManualWithinLimits(
        env.DB,
        { id: crypto.randomUUID(), userId: a.id, startsAt, endsAt, label: null, now: h.clock.now },
        100,
      );
    // longEdge（from - 24h + 1min 〜 from + 1min）と1分重なる
    expect(await insert(from, from + HOUR)).toBe(false);
    expect(await insert(from + 3 * HOUR, from + 4 * HOUR)).toBe(true);
  });

  it("追加：未来の枠が上限に達していれば追加しない（24時間前に始まりまだ終わっていない枠も数える）", async () => {
    const u = makeUsers(h);
    const a = await u.user("あき");
    const now = h.clock.now;
    await env.DB.prepare(
      "INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 0)",
    )
      .bind(crypto.randomUUID(), a.id, now - DAY + MIN, now + MIN)
      .run();
    const insert = () =>
      availabilityRepo.insertManualWithinLimits(
        env.DB,
        { id: crypto.randomUUID(), userId: a.id, startsAt: now + DAY, endsAt: now + DAY + HOUR, label: null, now },
        1,
      );
    expect(await insert()).toBe(false);
  });
});

describe("終わったここ暇の掃除", () => {
  it("始まりが2日より前の枠を消し、それより新しい枠は残す", async () => {
    const u = makeUsers(h);
    const a = await u.user("あき");
    const now = h.clock.now;
    expect(AVAILABILITY_RETENTION_MS).toBe(2 * DAY);
    const insert = async (startsAt: number) => {
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 0)",
      )
        .bind(id, a.id, startsAt, startsAt + DAY)
        .run();
      return id;
    };
    await insert(now - 2 * DAY - 1);
    const kept = await insert(now - 2 * DAY + 1);
    await cleanupExpired(h.ctx);
    const left = await env.DB.prepare("SELECT id FROM availabilities WHERE user_id = ?1").bind(a.id).all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual([kept]);
  });

  it("1回に消すのは上限まで", async () => {
    const [userId] = await seedUsers(1);
    await env.DB.batch(
      Array.from({ length: 5 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?1, ?2, ?3, ?4, NULL, 0)",
        ).bind(crypto.randomUUID(), userId, i * HOUR, i * HOUR + HOUR),
      ),
    );
    expect(await availabilityRepo.deleteManualStartedBefore(env.DB, h.clock.now, 3)).toBe(3);
    expect(await availabilityRepo.deleteManualStartedBefore(env.DB, h.clock.now, 3)).toBe(2);
  });
});

describe("定期処理の独立とログ", () => {
  it("outbox を流す処理が失敗しても掃除は走り、step と例外の名前だけのログが出る", async () => {
    await seedOutbox(1, h.clock.now - OUTBOX_RETENTION_MS - 1);
    const failing = {
      ...h.bindings,
      JOBS: {
        sendBatch: async () => {
          throw new TypeError("queue down secret-token");
        },
      } as unknown as Queue<never>,
    };
    await seedOutbox(1);
    await expect(runScheduled("* * * * *", failing, h.deps)).resolves.toBeUndefined();
    expect(events("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "dispatch_outbox", name: "TypeError" }]);
    expect(warns.some((l) => l.includes('"event":"cron_step_failed"'))).toBe(true);
    expect(logs.join("\n")).not.toContain("secret-token");
    // 掃除は走った（処理済みで7日を過ぎた行が消えた）
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE processed_at IS NOT NULL").first<{ n: number }>();
    expect(old?.n).toBe(0);
  });

  it("掃除の1つが失敗しても、残りの掃除は走る", async () => {
    await seedOutbox(1, h.clock.now - OUTBOX_RETENTION_MS - 1);
    const original = env.DB;
    // ics_tokens の掃除だけを失敗させる D1
    const db = new Proxy(original, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("DELETE FROM ics_tokens")) throw new RangeError("boom");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await cleanupExpired({ env: { ...h.bindings, DB: db }, deps: h.deps });
    expect(events("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "cleanup_ics_tokens", name: "RangeError" }]);
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE processed_at IS NOT NULL").first<{ n: number }>();
    expect(old?.n).toBe(0);
  });

  /** needle を含む SQL の prepare だけを失敗させる D1 */
  const failingOn = (needle: string) =>
    new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes(needle)) throw new RangeError("boom");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  it("保持期間の掃除（T-17）の1つが失敗しても、残りの掃除は走る", async () => {
    const [owner] = await seedUsers(1);
    const linkId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO invite_links (id, owner_id, token_hash, max_uses, uses, expires_at, created_at) VALUES (?1, ?2, ?1, 1, 0, ?3, ?3)",
    )
      .bind(linkId, owner, h.clock.now - RETENTION_MS - 1)
      .run();
    await seedOutbox(1, h.clock.now - OUTBOX_RETENTION_MS - 1);
    await cleanupExpired({ env: { ...h.bindings, DB: failingOn("DELETE FROM direct_invites") }, deps: h.deps });
    expect(events("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "cleanup_invitations", name: "RangeError" }]);
    // 前の掃除も後の掃除も走った
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM invite_links WHERE id = ?1").bind(linkId).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE processed_at IS NOT NULL").first<{ n: number }>();
    expect(old?.n).toBe(0);
  });

  it("15分ごと：休眠にする処理が失敗しても、戻す・購読の掃除・割り当てが走る（T-17）", async () => {
    const [due] = await seedUsers(1);
    await env.DB.prepare(
      "INSERT INTO calendar_connections (user_id, provider, status, connected_at, updated_at) VALUES (?1, 'google', 'active', 0, 0)",
    )
      .bind(due)
      .run();
    const sessionId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, revoked_at) VALUES (?1, ?2, 0, 0, 0, 0)").bind(
        sessionId,
        due,
      ),
      env.DB.prepare(
        "INSERT INTO push_subscriptions (id, user_id, session_id, endpoint_hash, endpoint_enc, created_at) VALUES (?1, ?2, ?3, ?1, 'enc', 0)",
      ).bind(crypto.randomUUID(), due, sessionId),
    ]);
    h.jobs.length = 0;
    await runScheduled("*/15 * * * *", { ...h.bindings, DB: failingOn("SET dormant_since = ?1") }, h.deps);
    expect(events("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "mark_dormant_connections", name: "RangeError" }]);
    expect(h.jobs).toContainEqual({ kind: "calendar_sync", userId: due, provider: "google" });
    const subs = await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE session_id = ?1").bind(sessionId).first<{ n: number }>();
    expect(subs?.n).toBe(0);
  });

  it("割り当てが失敗しても runScheduled は投げず、ログが出る", async () => {
    const failing = {
      ...h.bindings,
      DB: {
        prepare: () => {
          throw new Error("db down");
        },
      } as unknown as D1Database,
    };
    await expect(runScheduled("*/15 * * * *", failing, h.deps)).resolves.toBeUndefined();
    // 休眠・購読の掃除（T-17）と動いた記録（T-13）も同じ D1 に書くので、それぞれ独立に失敗する
    expect(events("cron_step_failed")).toEqual([
      { event: "cron_step_failed", step: "mark_dormant_connections", name: "Error" },
      { event: "cron_step_failed", step: "wake_dormant_connections", name: "Error" },
      { event: "cron_step_failed", step: "cleanup_push_subscriptions", name: "Error" },
      { event: "cron_step_failed", step: "assign_syncs", name: "Error" },
      { event: "cron_step_failed", step: "heartbeat", name: "Error" },
    ]);
  });
});

describe("インデックスを使う（EXPLAIN QUERY PLAN）", () => {
  /** 関数を記録用の D1 で呼び、記録した SQL のうち表全体を読むものを返す */
  async function scansOf(fn: (d1: D1Database) => Promise<unknown>) {
    const { db, recorded } = recordingD1(env.DB);
    await fn(db);
    expect(recorded.length).toBeGreaterThan(0);
    const out: { sql: string; scans: string[] }[] = [];
    for (const entry of recorded) {
      const scans = fullScans(await queryPlan(env.DB, entry));
      if (scans.length > 0) out.push({ sql: entry.sql, scans });
    }
    return out;
  }

  const now = Date.parse("2026-10-10T00:00:00Z");
  const from = now;
  const to = now + DAY;

  it("道具の確認：インデックスのない条件と、インデックスで並べられない ORDER BY は見つかる", async () => {
    expect(fullScans(await queryPlan(env.DB, { sql: "SELECT id FROM availabilities WHERE label = ?1", binds: ["x"] }))).not.toEqual([]);
    const oldOrder = {
      sql: `SELECT user_id FROM calendar_connections WHERE status = 'active' AND (last_synced_at IS NULL OR last_synced_at <= ?1)
            ORDER BY last_synced_at IS NOT NULL, last_synced_at LIMIT ?2`,
      binds: [now, 10],
    };
    expect(fullScans(await queryPlan(env.DB, oldOrder))).not.toEqual([]);
  });

  it("掃除の SQL", async () => {
    expect(await scansOf((d1) => calendarRepo.deleteExpiredIcsTokens(d1, now))).toEqual([]);
    expect(await scansOf((d1) => notificationRepo.deleteOldCounts(d1, "2026-10-07"))).toEqual([]);
    expect(await scansOf((d1) => linkPreviewRepo.deleteStalePreviews(d1, now - DAY, now - HOUR, 100))).toEqual([]);
    expect(await scansOf((d1) => deleteProcessedOutbox(d1, now - OUTBOX_RETENTION_MS, CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => availabilityRepo.deleteManualStartedBefore(d1, now - AVAILABILITY_RETENTION_MS, CLEANUP_BATCH))).toEqual(
      [],
    );
  });

  it("カレンダーの確認の割り当て（休眠中の行は、インデックスの範囲の外）", async () => {
    expect(await scansOf((d1) => calendarRepo.connectionsDueForSync(d1, now, 10 * MIN, SYNC_BATCH))).toEqual([]);
    const { db, recorded } = recordingD1(env.DB);
    await calendarRepo.connectionsDueForSync(db, now, 10 * MIN, SYNC_BATCH);
    expect((await queryPlan(env.DB, recorded[0]!)).join("\n")).toMatch(
      /USING INDEX calendar_connections_sync \(status=\? AND dormant_since=\?/,
    );
  });

  it("保持期間の掃除の SQL（T-17）", async () => {
    const cutoff = now - RETENTION_MS;
    expect(await scansOf((d1) => invitationRepo.deleteInvitesEndedBefore(d1, cutoff, CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => broadcastRepo.deleteBroadcastsEndedBefore(d1, cutoff, BROADCAST_CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => notificationRepo.deleteOldNotifications(d1, cutoff, CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => socialRepo.deleteInviteLinksExpiredBefore(d1, cutoff, CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => availabilityRepo.deleteExceptionsBefore(d1, exceptionCutoffDate(now), CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => deleteStaleNotificationOutbox(d1, cutoff, CLEANUP_BATCH))).toEqual([]);
    expect(await scansOf((d1) => notificationRepo.deleteSubscriptionsOfDeadSessions(d1, now, CLEANUP_BATCH))).toEqual([]);
  });

  it("誘い・募集を消すときの CASCADE の子の検索（T-17）", async () => {
    for (const [table, column] of [
      ["meetups", "direct_invite_id"],
      ["meetups", "broadcast_id"],
      ["meetup_participants", "meetup_id"],
      ["broadcast_recipients", "broadcast_id"],
      ["ics_tokens", "meetup_id"],
      ["link_preview_refs", "direct_invite_id"],
      ["link_preview_refs", "broadcast_id"],
    ] as const) {
      const plan = await queryPlan(env.DB, { sql: `SELECT 1 FROM ${table} WHERE ${column} = ?1`, binds: ["x"] });
      expect(fullScans(plan), `${table}.${column}`).toEqual([]);
    }
  });

  it("休眠にする・戻す（T-17。インデックスの範囲で読む）", async () => {
    const cutoff = now - DORMANT_AFTER_MS;
    expect(await scansOf((d1) => calendarRepo.markDormantConnections(d1, now, cutoff, DORMANCY_BATCH))).toEqual([]);
    expect(await scansOf((d1) => calendarRepo.wakeDormantConnections(d1, now, cutoff, DORMANCY_BATCH))).toEqual([]);
    const { db, recorded } = recordingD1(env.DB);
    await calendarRepo.wakeDormantConnections(db, now, cutoff, DORMANCY_BATCH);
    expect((await queryPlan(env.DB, recorded[0]!)).join("\n")).toMatch(/calendar_connections_sync \(status=\? AND dormant_since>\?\)/);
  });

  it("ここ暇の4つの検索", async () => {
    const [userId] = await seedUsers(1);
    expect(await scansOf((d1) => availabilityRepo.listMyManual(d1, userId!, from, to, now))).toEqual([]);
    expect(await scansOf((d1) => availabilityRepo.myManualWithCreatedAt(d1, userId!, from, to, now))).toEqual([]);
    expect(await scansOf((d1) => availabilityRepo.visibleManual(d1, userId!, { from, to, now }))).toEqual([]);
    expect(
      await scansOf((d1) =>
        availabilityRepo.insertManualWithinLimits(
          d1,
          { id: crypto.randomUUID(), userId: userId!, startsAt: from, endsAt: from + HOUR, label: null, now },
          100,
        ),
      ),
    ).toEqual([]);
  });
});
