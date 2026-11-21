import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers } from "../../test/users";
import * as availabilityRepo from "../availability/infra/repository";
import { assignSyncs, SYNC_BATCH } from "../calendar/application/sync";
import * as calendarRepo from "../calendar/infra/repository";
import type { Bindings, JobMessage } from "../env";
import * as previewRepo from "../link-preview/infra/repository";
import * as notificationRepo from "../notification/infra/repository";
import { runScheduled } from "../worker";
import {
  AVAILABILITY_RETENTION_MS,
  cleanupExpired,
  deleteProcessedOutbox,
  dispatchOutbox,
  OUTBOX_RETENTION_MS,
} from "./dispatch";

// データの増加への備え（docs/specs/T-12-data-growth.md）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;
let logs: Record<string, unknown>[] = [];

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  // テストの間で DB は共有されるので、数を数える表は空にしてから始める
  await env.DB.batch([
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM calendar_connections"),
    env.DB.prepare("DELETE FROM availabilities"),
  ]);
  logs = [];
  const capture = (line: unknown) => {
    try {
      logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    } catch {
      // JSON でない行は見ない
    }
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (event: string) => logs.filter((l) => l.event === event);
const numbers = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => i));
const count = async (sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())?.n ?? 0;

/** 流す型の outbox の行を n 件足す。processedAt を渡すと処理済みの行になる */
async function addOutbox(n: number, opts: { type?: string; createdAt?: number; processedAt?: number | null; prefix?: string } = {}) {
  await env.DB.prepare(
    `INSERT INTO outbox (id, type, payload, created_at, processed_at)
     SELECT ?1 || '-' || value, ?2, '{}', ?3 + value, ?4 FROM json_each(?5)`,
  )
    .bind(opts.prefix ?? crypto.randomUUID(), opts.type ?? "MeetupLeft", opts.createdAt ?? 0, opts.processedAt ?? null, numbers(n))
    .run();
}

const unprocessed = () => count("SELECT COUNT(*) AS n FROM outbox WHERE processed_at IS NULL");

/** D1 に渡した SQL を記録する。fail に当てはまる SQL は例外を投げる */
function watchedDb(seen: string[], fail?: (sql: string) => boolean): D1Database {
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          seen.push(sql);
          if (fail?.(sql)) throw new Error("secret-value-in-message");
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("outbox を Queue に流す（T-12）", () => {
  it("未処理の行が250件あると、1回の実行で250件が送られ、すべて処理済みになる", async () => {
    await addOutbox(250);
    expect(await dispatchOutbox(h.ctx)).toBe(250);
    expect(h.jobs).toHaveLength(250);
    expect(await unprocessed()).toBe(0);
    expect(logged("outbox_dispatch_capped")).toEqual([]);
  });

  it("未処理の行が1500件あると、1回の実行で1000件だけが送られ、残りは次の実行で送られる", async () => {
    await addOutbox(1500);
    expect(await dispatchOutbox(h.ctx)).toBe(1000);
    expect(h.jobs).toHaveLength(1000);
    expect(await unprocessed()).toBe(500);
    expect(logged("outbox_dispatch_capped")).toEqual([{ event: "outbox_dispatch_capped", reason: "count", sent: 1000 }]);

    logs = [];
    expect(await dispatchOutbox(h.ctx)).toBe(500);
    expect(await unprocessed()).toBe(0);
    expect(logged("outbox_dispatch_capped")).toEqual([]);
  });

  it("実行が20秒を過ぎたら、次の回に入らない", async () => {
    await addOutbox(300);
    const sent: JobMessage[] = [];
    const slow: Bindings = {
      ...h.bindings,
      JOBS: {
        sendBatch: async (messages: Iterable<{ body: JobMessage }>) => {
          for (const m of messages) sent.push(m.body);
          h.clock.now += 11 * 1000;
        },
      } as unknown as Queue<JobMessage>,
    };
    // 1回目（0秒→11秒）、2回目（11秒→22秒）。3回目は20秒を過ぎているので入らない
    expect(await dispatchOutbox({ env: slow, deps: h.deps })).toBe(200);
    expect(sent).toHaveLength(200);
    expect(await unprocessed()).toBe(100);
    expect(logged("outbox_dispatch_capped")).toEqual([{ event: "outbox_dispatch_capped", reason: "time", sent: 200 }]);
  });

  it("ちょうど20秒では、次の回に入る", async () => {
    await addOutbox(150);
    const slow: Bindings = {
      ...h.bindings,
      JOBS: {
        sendBatch: async () => {
          h.clock.now += 20 * 1000;
        },
      } as unknown as Queue<JobMessage>,
    };
    expect(await dispatchOutbox({ env: slow, deps: h.deps })).toBe(150);
    expect(logged("outbox_dispatch_capped")).toEqual([]);
  });

  it("処理済みになって7日を過ぎた行が消え、7日以内の行と未処理の行は残る", async () => {
    const now = h.clock.now;
    await addOutbox(1, { prefix: "old", processedAt: now - OUTBOX_RETENTION_MS - 1 });
    await addOutbox(1, { prefix: "edge", processedAt: now - OUTBOX_RETENTION_MS });
    await addOutbox(1, { prefix: "recent", processedAt: now - HOUR });
    // 流す型がまだない未処理の行は、古くても残す
    await addOutbox(1, { prefix: "unknown", type: "SomethingElse", createdAt: now - 30 * DAY });
    await cleanupExpired(h.ctx);
    const { results } = await env.DB.prepare("SELECT id FROM outbox ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["edge-0", "recent-0", "unknown-0"]);
  });

  it("処理済みの行を1回で消すのは最大1000行", async () => {
    await addOutbox(1100, { processedAt: h.clock.now - OUTBOX_RETENTION_MS - 1 });
    await cleanupExpired(h.ctx);
    expect(await count("SELECT COUNT(*) AS n FROM outbox")).toBe(100);
    await cleanupExpired(h.ctx);
    expect(await count("SELECT COUNT(*) AS n FROM outbox")).toBe(0);
  });
});

describe("カレンダーの確認の割り当て（T-12）", () => {
  /** 連携を n 件足す。先頭の fresh 件は確認したことがない（NULL）。残りは番号の小さいほうが古い */
  async function addConnections(n: number, fresh: number) {
    const now = h.clock.now;
    await env.DB.prepare(
      `INSERT INTO users (id, created_at, updated_at) SELECT 'sync-user-' || value, ?1, ?1 FROM json_each(?2)
       WHERE true ON CONFLICT (id) DO NOTHING`,
    )
      .bind(now, numbers(n))
      .run();
    await env.DB.prepare(
      `INSERT INTO calendar_connections (user_id, provider, status, connected_at, updated_at, last_synced_at)
       SELECT 'sync-user-' || value, 'google', 'active', ?1, ?1, CASE WHEN value < ?2 THEN NULL ELSE ?3 + value END
       FROM json_each(?4)`,
    )
      .bind(now, fresh, now - DAY, numbers(n))
      .run();
  }
  const assigned = () =>
    h.jobs.flatMap((j) => (j.kind === "calendar_sync" ? [Number(j.userId.replace("sync-user-", ""))] : []));

  it("1200人が対象のとき、1回の割り当てで1000人が送られる。確認したことがない連携が先、次に古い順", async () => {
    await addConnections(1200, 100);
    expect(await assignSyncs(h.ctx)).toBe(1000);
    const ids = assigned();
    expect(ids).toHaveLength(1000);
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: 1000 }, (_, i) => i)));
    // 確認したことがない100件が、ほかより先に並ぶ
    expect(Math.max(...ids.slice(0, 100))).toBeLessThan(100);
    expect(ids.slice(100)).toEqual(Array.from({ length: 900 }, (_, i) => i + 100));
    expect(logged("calendar_sync_assign_full")).toEqual([{ event: "calendar_sync_assign_full", assigned: SYNC_BATCH }]);
  });

  it("999人なら、上限で埋まったログは出ない", async () => {
    await addConnections(999, 0);
    expect(await assignSyncs(h.ctx)).toBe(999);
    expect(logged("calendar_sync_assign_full")).toEqual([]);
  });
});

describe("ここ暇（手動の枠）の検索と掃除（T-12）", () => {
  const add = (userId: string, id: string, startsAt: number, endsAt: number) =>
    env.DB.prepare("INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)")
      .bind(id, userId, startsAt, endsAt, startsAt - DAY)
      .run();

  it("範囲の始まりの24時間前の直後に始まり、範囲と重なる枠が、一覧・友達の空き・自動取り消しの対象に入る", async () => {
    const a = await u.user("あ");
    const b = await u.user("い");
    await u.befriend(a, b);
    const from = h.clock.now + 2 * DAY;
    const to = from + DAY;
    const now = h.clock.now;
    // 長さは上限の24時間。範囲とは1分だけ重なる
    await add(a.id, "edge-start", from - DAY + MIN, from + MIN);
    // 範囲の終わりちょうどに始まる枠は入らない
    await add(a.id, "at-end", to, to + HOUR);
    // 範囲の中の枠
    await add(a.id, "inside", from + HOUR, from + 2 * HOUR);

    const mine = await availabilityRepo.listMyManual(env.DB, a.id, from, to, now);
    expect(mine.map((r) => r.id)).toEqual(["edge-start", "inside"]);
    const friends = await availabilityRepo.visibleManual(env.DB, b.id, { from, to, now });
    expect(friends.map((r) => r.id).sort()).toEqual(["edge-start", "inside"]);
    const cancellable = await availabilityRepo.myManualWithCreatedAt(env.DB, a.id, from, to, now);
    expect(cancellable.map((r) => r.id)).toEqual(["edge-start", "inside"]);
  });

  it("重なりの判定と「未来の枠が100個まで」の数え方は、いままでと同じ結果になる", async () => {
    const a = await u.user("あ");
    const now = h.clock.now;
    const row = (id: string, startsAt: number, endsAt: number) => ({ id, userId: a.id, startsAt, endsAt, label: null, now });
    // 24時間の枠。直後に始まる枠は重ならず、終わりの1分前に始まる枠は重なる
    expect(await availabilityRepo.insertManualWithinLimits(env.DB, row("long", now + HOUR, now + HOUR + DAY), 100)).toBe(true);
    expect(await availabilityRepo.insertManualWithinLimits(env.DB, row("after", now + HOUR + DAY, now + 2 * HOUR + DAY), 100)).toBe(true);
    expect(
      await availabilityRepo.insertManualWithinLimits(env.DB, row("overlap", now + DAY + 59 * MIN, now + DAY + 90 * MIN), 100),
    ).toBe(false);
    // いま進行中の枠（24時間前の直後に始まった）も、未来の枠として数える
    await add(a.id, "ongoing", now - DAY + MIN, now + MIN);
    expect(await availabilityRepo.insertManualWithinLimits(env.DB, row("over-limit", now + 5 * DAY, now + 5 * DAY + HOUR), 3)).toBe(false);
    expect(await availabilityRepo.insertManualWithinLimits(env.DB, row("within-limit", now + 5 * DAY, now + 5 * DAY + HOUR), 4)).toBe(true);
  });

  it("始まりが2日より前の行が消え、それより新しい行は残る", async () => {
    const a = await u.user("あ");
    const now = h.clock.now;
    await add(a.id, "old", now - AVAILABILITY_RETENTION_MS - 1, now - AVAILABILITY_RETENTION_MS + HOUR);
    await add(a.id, "edge", now - AVAILABILITY_RETENTION_MS, now - AVAILABILITY_RETENTION_MS + HOUR);
    await add(a.id, "future", now + HOUR, now + 2 * HOUR);
    await cleanupExpired(h.ctx);
    const { results } = await env.DB.prepare("SELECT id FROM availabilities ORDER BY id").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["edge", "future"]);
  });

  it("終わったここ暇を1回で消すのは最大1000行", async () => {
    const a = await u.user("あ");
    const old = h.clock.now - 10 * DAY;
    await env.DB.prepare(
      `INSERT INTO availabilities (id, user_id, starts_at, ends_at, label, created_at)
       SELECT 'gone-' || value, ?1, ?2 + value, ?2 + value + 1000, NULL, ?2 FROM json_each(?3)`,
    )
      .bind(a.id, old, numbers(1100))
      .run();
    await cleanupExpired(h.ctx);
    expect(await count("SELECT COUNT(*) AS n FROM availabilities")).toBe(100);
  });
});

describe("インデックス（T-12）", () => {
  /** 実際に使う SQL を記録し、その実行計画を返す */
  async function plansOf(run: (d1: D1Database) => Promise<unknown>) {
    const seen: string[] = [];
    await run(watchedDb(seen));
    expect(seen.length).toBeGreaterThan(0);
    const plans: string[] = [];
    for (const sql of seen) {
      const params = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...Array.from({ length: params }, () => "[]"))
        .all<{ detail: string }>();
      plans.push(...results.map((r) => r.detail));
    }
    return plans;
  }

  const range = { from: 0, to: DAY, now: 0 };
  const cases: [string, (d1: D1Database) => Promise<unknown>][] = [
    ["期限切れの ics_tokens の削除", (d1) => calendarRepo.deleteExpiredIcsTokens(d1, 0)],
    ["古い notification_daily_counts の削除", (d1) => notificationRepo.deleteOldCounts(d1, "2026-01-01")],
    ["古い link_previews の削除", (d1) => previewRepo.deleteStalePreviews(d1, 0, 0, 100)],
    ["処理済みの outbox の削除", (d1) => deleteProcessedOutbox(d1, 0, 1000)],
    ["終わったここ暇の削除", (d1) => availabilityRepo.deleteEndedManual(d1, 0, 1000)],
    ["カレンダーの確認の割り当て", (d1) => calendarRepo.connectionsDueForSync(d1, 0, 0, 1000)],
    ["ここ暇：自分の一覧", (d1) => availabilityRepo.listMyManual(d1, "u", range.from, range.to, range.now)],
    ["ここ暇：友達の空き", (d1) => availabilityRepo.visibleManual(d1, "u", range)],
    ["ここ暇：自動取り消しの対象", (d1) => availabilityRepo.myManualWithCreatedAt(d1, "u", range.from, range.to, range.now)],
    [
      "ここ暇：追加するときの重なりの判定",
      (d1) =>
        availabilityRepo.insertManualWithinLimits(
          d1,
          { id: crypto.randomUUID(), userId: "missing-user", startsAt: DAY, endsAt: DAY + HOUR, label: null, now: 0 },
          0,
        ),
    ],
  ];

  it.each(cases)("%s は、表全体を読まず、並び替えのための一時的な B-tree を使わない", async (_name, run) => {
    const plans = await plansOf(run);
    expect(plans.length).toBeGreaterThan(0);
    for (const detail of plans) {
      // インデックスを使わない SCAN（json_each などの仮想の表は除く）
      if (/^SCAN /.test(detail)) expect(detail).toMatch(/USING (COVERING )?INDEX|VIRTUAL TABLE|CONSTANT ROW/);
      expect(detail).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    }
  });
});

describe("定期処理の独立とログ（T-12）", () => {
  const failingQueue = (): Bindings => ({
    ...h.bindings,
    JOBS: {
      sendBatch: async () => {
        throw new TypeError("queue down: secret-value-in-message");
      },
    } as unknown as Queue<JobMessage>,
  });

  it("outbox を流す処理が例外を投げても、掃除が走る", async () => {
    await addOutbox(1, { prefix: "pending" });
    await addOutbox(1, { prefix: "old", processedAt: h.clock.now - OUTBOX_RETENTION_MS - 1 });
    await expect(runScheduled("* * * * *", failingQueue(), h.deps)).resolves.toBeUndefined();
    const { results } = await env.DB.prepare("SELECT id, processed_at FROM outbox").all<{ id: string; processed_at: number | null }>();
    // 送れなかった行は未処理のまま残り、古い処理済みの行は掃除されている
    expect(results).toEqual([{ id: "pending-0", processed_at: null }]);
    expect(logged("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "dispatch_outbox", name: "TypeError" }]);
  });

  it("掃除の1つが例外を投げても、残りの掃除が走る。ログには処理の名前と例外の名前だけが出る", async () => {
    await addOutbox(1, { prefix: "old", processedAt: h.clock.now - OUTBOX_RETENTION_MS - 1 });
    const seen: string[] = [];
    const broken: Bindings = { ...h.bindings, DB: watchedDb(seen, (sql) => sql.includes("DELETE FROM ics_tokens")) };
    await expect(runScheduled("* * * * *", broken, h.deps)).resolves.toBeUndefined();
    expect(await count("SELECT COUNT(*) AS n FROM outbox")).toBe(0);
    expect(logged("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "cleanup_ics_tokens", name: "Error" }]);
    expect(JSON.stringify(logs)).not.toContain("secret-value-in-message");
  });

  it("割り当てが例外を投げても runScheduled は投げない", async () => {
    const a = await u.user("あ");
    await env.DB.prepare(
      "INSERT INTO calendar_connections (user_id, provider, status, connected_at, updated_at) VALUES (?1, 'google', 'active', ?2, ?2)",
    )
      .bind(a.id, h.clock.now)
      .run();
    await expect(runScheduled("*/15 * * * *", failingQueue(), h.deps)).resolves.toBeUndefined();
    expect(logged("cron_step_failed")).toEqual([{ event: "cron_step_failed", step: "assign_syncs", name: "TypeError" }]);
    expect(JSON.stringify(logs)).not.toContain("secret-value-in-message");
  });

  it("失敗がなければ cron_step_failed は出ない", async () => {
    await runScheduled("* * * * *", h.bindings, h.deps);
    await runScheduled("*/15 * * * *", h.bindings, h.deps);
    expect(logged("cron_step_failed")).toEqual([]);
  });
});
