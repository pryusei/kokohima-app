import { env } from "cloudflare:workers";
import { errorCodeSchema } from "@kokohima/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { makeUsers } from "../../test/users";
import wranglerConfig from "../../wrangler.jsonc?raw";
import type { Bindings, JobMessage } from "../env";
import { runScheduled } from "../worker";
import { handleBatch } from "./consumer";
import { CALENDAR_SYNC_STALE_MS, checkReadiness, MINUTELY_STALE_MS, OUTBOX_BACKLOG_MS } from "./health";

// 監視とアラート（docs/specs/T-13-monitoring.md）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let u: ReturnType<typeof makeUsers>;
let lines: { level: "log" | "warn" | "error"; body: Record<string, unknown> }[] = [];

const PATH = "/api/v1/health/ready";
const MIN = 60 * 1000;

const setRun = (name: string, at: number) =>
  env.DB.prepare("INSERT INTO cron_runs (name, last_run_at) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET last_run_at = ?2")
    .bind(name, at)
    .run();
const lastRun = async (name: string) =>
  (await env.DB.prepare("SELECT last_run_at FROM cron_runs WHERE name = ?1").bind(name).first<{ last_run_at: number }>())?.last_run_at;
const addOutbox = (id: string, type: string, createdAt: number, processedAt: number | null = null) =>
  env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at, processed_at) VALUES (?1, ?2, '{}', ?3, ?4)")
    .bind(id, type, createdAt, processedAt)
    .run();

beforeEach(async () => {
  h = await createHarness();
  u = makeUsers(h);
  // このファイルの中ではストレージが共有されるので、死活確認が読む表をそろえてから始める
  await env.DB.batch([env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM cron_runs")]);
  await setRun("minutely", h.clock.now);
  await setRun("calendar_sync", h.clock.now);
  lines = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((line: unknown) => {
      try {
        lines.push({ level, body: JSON.parse(String(line)) as Record<string, unknown> });
      } catch {
        // JSON でない行は見ない
      }
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

const logged = (event: string) => lines.filter((l) => l.body.event === event);

/** prepare に当てはまる SQL が来たら例外を投げる D1 */
function brokenDb(fail: (sql: string) => boolean): D1Database {
  const failing = (sql: string) => {
    if (fail(sql)) throw new Error("secret-value-in-message");
  };
  return new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          failing(sql);
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("深い死活確認 GET /api/v1/health/ready", () => {
  it("すべて新しければ 200。認証なしで呼べて、利用者のデータを返さない", async () => {
    const res = await h.request(PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(logged("health_degraded")).toEqual([]);
  });

  it("もとの GET /api/v1/health は変わらない（定期処理が止まっていても 200）", async () => {
    await setRun("minutely", h.clock.now - 60 * MIN);
    const res = await h.request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("毎分の処理が5分より前から動いていなければ 503、ちょうど5分なら 200。行がなければ 503", async () => {
    await setRun("minutely", h.clock.now - MINUTELY_STALE_MS);
    expect((await h.request(PATH)).status).toBe(200);
    await setRun("minutely", h.clock.now - MINUTELY_STALE_MS - 1);
    expect((await h.request(PATH)).status).toBe(503);
    expect(logged("health_degraded").map((l) => l.body)).toEqual([{ event: "health_degraded", reason: "cron_minutely" }]);

    await env.DB.prepare("DELETE FROM cron_runs WHERE name = 'minutely'").run();
    expect((await h.request(PATH)).status).toBe(503);
  });

  it("15分ごとの割り当てが45分より前から動いていなければ 503、ちょうど45分なら 200。行がなければ 503", async () => {
    await setRun("calendar_sync", h.clock.now - CALENDAR_SYNC_STALE_MS);
    expect((await h.request(PATH)).status).toBe(200);
    await setRun("calendar_sync", h.clock.now - CALENDAR_SYNC_STALE_MS - 1);
    expect((await h.request(PATH)).status).toBe(503);
    expect(logged("health_degraded").map((l) => l.body)).toEqual([{ event: "health_degraded", reason: "cron_calendar_sync" }]);

    await env.DB.prepare("DELETE FROM cron_runs WHERE name = 'calendar_sync'").run();
    expect((await h.request(PATH)).status).toBe(503);
  });

  it("流す型の未処理の最古の行が10分より前なら 503、ちょうど10分なら 200", async () => {
    await addOutbox("edge", "MeetupLeft", h.clock.now - OUTBOX_BACKLOG_MS);
    expect((await h.request(PATH)).status).toBe(200);
    await addOutbox("old", "MeetupLeft", h.clock.now - OUTBOX_BACKLOG_MS - 1);
    expect((await h.request(PATH)).status).toBe(503);
    expect(logged("health_degraded").map((l) => l.body)).toEqual([{ event: "health_degraded", reason: "outbox_backlog" }]);
  });

  it("処理済みの行と、流す型でない未処理の行では 503 にならない", async () => {
    await addOutbox("done", "MeetupLeft", h.clock.now - 60 * MIN, h.clock.now - 50 * MIN);
    await addOutbox("unknown", "SomethingElse", h.clock.now - 60 * MIN);
    expect((await h.request(PATH)).status).toBe(200);
  });

  it("D1 の読み取りが失敗すると 503（理由は db）", async () => {
    const broken: Bindings = { ...h.bindings, DB: brokenDb((sql) => sql.includes("cron_runs")) };
    expect(await checkReadiness({ env: broken, deps: h.deps })).toBe("db");
    const res = await h.app.request(PATH, {}, broken);
    expect(res.status).toBe(503);
    expect(logged("health_degraded").map((l) => l.body)).toEqual([{ event: "health_degraded", reason: "db" }]);
    expect(JSON.stringify(lines)).not.toContain("secret-value-in-message");
  });

  it("複数に当てはまるときの理由は、表の上から最初の1つ", async () => {
    await setRun("minutely", h.clock.now - 60 * MIN);
    await setRun("calendar_sync", h.clock.now - 120 * MIN);
    await addOutbox("old", "MeetupLeft", h.clock.now - 60 * MIN);
    expect(await checkReadiness(h.ctx)).toBe("cron_minutely");
  });

  it("503 の本文はどの理由でも同じで、理由・時刻・件数・利用者IDを含まない", async () => {
    const a = await u.user("あき");
    const bodies: Record<string, unknown>[] = [];
    const take = async (res: Response) => {
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toContain("application/problem+json");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const text = await res.text();
      expect(text).not.toMatch(/cron|outbox|backlog|minutely|calendar|reason/);
      expect(text).not.toContain(a.id);
      const { requestId, ...rest } = JSON.parse(text) as Record<string, unknown>;
      expect(typeof requestId).toBe("string");
      bodies.push(rest);
    };

    await addOutbox("old", "MeetupLeft", h.clock.now - 60 * MIN);
    await take(await h.request(PATH));
    await env.DB.prepare("DELETE FROM outbox").run();
    await setRun("calendar_sync", h.clock.now - 120 * MIN);
    await take(await h.request(PATH));
    await setRun("minutely", h.clock.now - 60 * MIN);
    await take(await h.request(PATH));
    await take(await h.app.request(PATH, {}, { ...h.bindings, DB: brokenDb((sql) => sql.includes("cron_runs")) }));

    const expected = { type: "about:blank", title: "Service Unavailable", status: 503, code: "unavailable" };
    expect(bodies).toEqual([expected, expected, expected, expected]);
    expect(errorCodeSchema.safeParse("unavailable").success).toBe(true);
  });

  it("ログは warn で、理由だけが出る", async () => {
    await setRun("minutely", h.clock.now - 60 * MIN);
    await h.request(PATH);
    expect(logged("health_degraded")).toEqual([{ level: "warn", body: { event: "health_degraded", reason: "cron_minutely" } }]);
  });

  it("回数の上限を超えると 429。IP ごとに数え、D1 は読まない", async () => {
    h.limiter.calls.length = 0;
    h.limiter.allow = () => false;
    const res = await h.request(PATH, { headers: { "CF-Connecting-IP": "203.0.113.7" } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(h.limiter.calls).toEqual([{ limiter: "RL_PUBLIC", key: "health_ready:ip4:203.0.113.7" }]);
  });

  it("何も書かない（読むだけ）", async () => {
    const before = await env.DB.prepare("SELECT name, last_run_at FROM cron_runs ORDER BY name").all();
    await h.request(PATH);
    const after = await env.DB.prepare("SELECT name, last_run_at FROM cron_runs ORDER BY name").all();
    expect(after.results).toEqual(before.results);
  });
});

describe("定期処理が動いた記録", () => {
  const failingQueue = (): Bindings => ({
    ...h.bindings,
    JOBS: {
      sendBatch: async () => {
        throw new TypeError("queue down");
      },
    } as unknown as Queue<JobMessage>,
  });

  it("毎分の処理の後に minutely、15分ごとの割り当ての後に calendar_sync が、いまの時刻になる", async () => {
    await setRun("minutely", 1);
    await setRun("calendar_sync", 2);
    h.clock.now += 3 * MIN;
    await runScheduled("* * * * *", h.bindings, h.deps);
    expect(await lastRun("minutely")).toBe(h.clock.now);
    expect(await lastRun("calendar_sync")).toBe(2);

    h.clock.now += MIN;
    await runScheduled("*/15 * * * *", h.bindings, h.deps);
    expect(await lastRun("calendar_sync")).toBe(h.clock.now);
    expect(await lastRun("minutely")).toBe(h.clock.now - MIN);
  });

  it("行がなくても記録できる", async () => {
    await env.DB.prepare("DELETE FROM cron_runs").run();
    await runScheduled("* * * * *", h.bindings, h.deps);
    expect(await lastRun("minutely")).toBe(h.clock.now);
  });

  it("途中の処理が例外を投げても、記録される", async () => {
    await setRun("minutely", 1);
    await setRun("calendar_sync", 2);
    await addOutbox("pending", "MeetupLeft", h.clock.now);
    const user = await u.user("あき");
    await env.DB.prepare(
      "INSERT INTO calendar_connections (user_id, provider, status, connected_at, updated_at) VALUES (?1, 'google', 'active', ?2, ?2)",
    )
      .bind(user.id, h.clock.now)
      .run();
    await runScheduled("* * * * *", failingQueue(), h.deps);
    await runScheduled("*/15 * * * *", failingQueue(), h.deps);
    expect(logged("cron_step_failed").map((l) => l.body.step)).toEqual(["dispatch_outbox", "assign_syncs"]);
    expect(await lastRun("minutely")).toBe(h.clock.now);
    expect(await lastRun("calendar_sync")).toBe(h.clock.now);
  });

  it("記録の書き込みが失敗すると cron_step_failed（step は heartbeat）が warn で出て、runScheduled は投げない", async () => {
    const broken: Bindings = { ...h.bindings, DB: brokenDb((sql) => sql.includes("INSERT INTO cron_runs")) };
    await expect(runScheduled("* * * * *", broken, h.deps)).resolves.toBeUndefined();
    await expect(runScheduled("*/15 * * * *", broken, h.deps)).resolves.toBeUndefined();
    expect(logged("cron_step_failed")).toEqual([
      { level: "warn", body: { event: "cron_step_failed", step: "heartbeat", name: "Error" } },
      { level: "warn", body: { event: "cron_step_failed", step: "heartbeat", name: "Error" } },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret-value-in-message");
  });
});

describe("ログの重さ（Monitors と Workers Issues の受け持ち）", () => {
  const failingMessage = (attempts: number) => ({
    // 中身が壊れた payload：consumer が例外を投げる
    body: { kind: "outbox" as const, id: "m1", type: "MeetupConfirmed", payload: "{not json" },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  });

  it("job_failed と job_dead_lettered は warn で出る。項目は変わらない", async () => {
    const retrying = failingMessage(1);
    const last = failingMessage(6);
    await handleBatch(h.ctx, { messages: [retrying, last] } as unknown as MessageBatch<JobMessage>);
    expect(retrying.retry).toHaveBeenCalled();
    expect(last.retry).toHaveBeenCalled();
    const fields = { kind: "outbox", type: "MeetupConfirmed", id: "m1", error: "SyntaxError" };
    expect(logged("job_failed")).toEqual([{ level: "warn", body: { event: "job_failed", ...fields, attempts: 1 } }]);
    expect(logged("job_dead_lettered")).toEqual([{ level: "warn", body: { event: "job_dead_lettered", ...fields, attempts: 6 } }]);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("unhandled_error は error のまま（Workers Issues が受け持つ）", async () => {
    const a = await u.user("あき");
    const broken: Bindings = { ...h.bindings, DB: brokenDb(() => true) };
    const res = await h.app.request("/api/v1/me", { headers: { Authorization: `Bearer ${a.token}` } }, broken);
    expect(res.status).toBe(500);
    const errors = logged("unhandled_error");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.level).toBe("error");
    expect(Object.keys(errors[0]?.body ?? {}).sort()).toEqual(["event", "name", "requestId"]);
  });
});

describe("wrangler の設定", () => {
  /** JSONC のコメントを外して読む（文字列の中の // は残す） */
  function parseJsonc(text: string): unknown {
    let out = "";
    let inString = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i] ?? "";
      if (inString) {
        out += ch;
        if (ch === "\\") out += text[++i] ?? "";
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
        out += ch;
      } else if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        out += "\n";
      } else {
        out += ch;
      }
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  }

  type Observability = { enabled?: boolean; logs?: { invocation_logs?: boolean }; issues?: { enabled?: boolean } };
  const config = parseJsonc(wranglerConfig) as { observability?: Observability; env: Record<string, { observability?: Observability }> };

  it("トップレベルと prod で Workers Issues が有効で、呼び出しのログは出さないまま", () => {
    for (const observability of [config.observability, config.env.prod?.observability]) {
      expect(observability).toEqual({ enabled: true, logs: { invocation_logs: false }, issues: { enabled: true } });
    }
  });

  it("ほかの環境は、トップレベルの設定を上書きしない", () => {
    for (const name of ["e2e", "staging"]) expect(config.env[name]?.observability).toBeUndefined();
  });
});
