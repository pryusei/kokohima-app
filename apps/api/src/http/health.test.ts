import { env } from "cloudflare:workers";
import wranglerConfig from "../../wrangler.jsonc?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness } from "../../test/identity-harness";
import { handleBatch } from "../jobs/consumer";
import { runScheduled } from "../worker";
import { CRON_CALENDAR_SYNC_STALE_MS, CRON_MINUTELY_STALE_MS, OUTBOX_BACKLOG_MS } from "./health";

// 監視とアラート（docs/specs/T-13-monitoring.md）。時計は 2026-10-10T00:00:00Z

let h: Awaited<ReturnType<typeof createHarness>>;
let warns: string[];

beforeEach(async () => {
  h = await createHarness();
  await env.DB.batch([env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM cron_runs")]);
  warns = [];
  vi.spyOn(console, "warn").mockImplementation((line: unknown) => void warns.push(String(line)));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const MIN = 60 * 1000;
const IP = "203.0.113.7";

const setRun = (name: string, at: number) =>
  env.DB.prepare("INSERT INTO cron_runs (name, last_run_at) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET last_run_at = ?2")
    .bind(name, at)
    .run();
const runAt = async (name: string) =>
  (await env.DB.prepare("SELECT last_run_at FROM cron_runs WHERE name = ?1").bind(name).first<{ last_run_at: number }>())?.last_run_at;
const fresh = async () => {
  await setRun("minutely", h.clock.now);
  await setRun("calendar_sync", h.clock.now);
};
const addOutbox = (type: string, createdAt: number, processedAt: number | null = null) =>
  env.DB.prepare("INSERT INTO outbox (id, type, payload, created_at, processed_at) VALUES (?1, ?2, '{}', ?3, ?4)")
    .bind(crypto.randomUUID(), type, createdAt, processedAt)
    .run();
const ready = () => h.request("/api/v1/health/ready", { headers: { "CF-Connecting-IP": IP } });
const degraded = () => warns.filter((l) => l.includes('"event":"health_degraded"')).map((l) => JSON.parse(l) as Record<string, unknown>);

describe("定期処理が動いた記録", () => {
  it("毎分の処理の後に minutely、15分ごとの割り当ての後に calendar_sync を、いまの時刻にする", async () => {
    await runScheduled("* * * * *", h.bindings, h.deps);
    expect(await runAt("minutely")).toBe(h.clock.now);
    expect(await runAt("calendar_sync")).toBeUndefined();
    h.clock.now += 15 * MIN;
    await runScheduled("*/15 * * * *", h.bindings, h.deps);
    expect(await runAt("calendar_sync")).toBe(h.clock.now);
    expect(await runAt("minutely")).toBe(h.clock.now - 15 * MIN);
  });

  it("途中の処理が例外を投げても記録する", async () => {
    const failing = {
      ...h.bindings,
      JOBS: {
        sendBatch: async () => {
          throw new Error("queue down");
        },
      } as unknown as Queue<never>,
    };
    await addOutbox("MeetupLeft", h.clock.now);
    await runScheduled("* * * * *", failing, h.deps);
    expect(warns.some((l) => l.includes('"step":"dispatch_outbox"'))).toBe(true);
    expect(await runAt("minutely")).toBe(h.clock.now);
  });

  it("15分ごとの割り当てが例外を投げても、calendar_sync を記録する", async () => {
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            // 割り当ての SQL だけ（休眠にする・戻す文も calendar_connections を読む。T-17）
            if (sql.includes("SELECT user_id, provider FROM calendar_connections")) throw new TypeError("boom");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runScheduled("*/15 * * * *", { ...h.bindings, DB: db }, h.deps);
    const failed = warns.filter((l) => l.includes('"event":"cron_step_failed"')).map((l) => JSON.parse(l) as unknown);
    expect(failed).toEqual([{ event: "cron_step_failed", step: "assign_syncs", name: "TypeError" }]);
    expect(await runAt("calendar_sync")).toBe(h.clock.now);
  });

  it("記録の書き込みが失敗すると cron_step_failed（heartbeat）を出し、runScheduled は投げない", async () => {
    const db = new Proxy(env.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO cron_runs")) throw new RangeError("boom");
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(runScheduled("*/15 * * * *", { ...h.bindings, DB: db }, h.deps)).resolves.toBeUndefined();
    const failed = warns.filter((l) => l.includes('"event":"cron_step_failed"')).map((l) => JSON.parse(l) as unknown);
    expect(failed).toEqual([{ event: "cron_step_failed", step: "heartbeat", name: "RangeError" }]);
  });
});

describe("深い死活確認 GET /api/v1/health/ready", () => {
  it("すべて新しければ200 { status: ok }。認証なしで呼べ、Cache-Control: no-store。ログは出ない", async () => {
    await fresh();
    const res = await ready();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(degraded()).toEqual([]);
  });

  it("minutely：5分より前なら503、ちょうど5分なら200。行がなければ503", async () => {
    await fresh();
    await setRun("minutely", h.clock.now - CRON_MINUTELY_STALE_MS);
    expect((await ready()).status).toBe(200);
    await setRun("minutely", h.clock.now - CRON_MINUTELY_STALE_MS - 1);
    expect((await ready()).status).toBe(503);
    await env.DB.prepare("DELETE FROM cron_runs WHERE name = 'minutely'").run();
    expect((await ready()).status).toBe(503);
    expect(degraded().map((d) => d.reason)).toEqual(["cron_minutely", "cron_minutely"]);
    expect(CRON_MINUTELY_STALE_MS).toBe(5 * MIN);
  });

  it("calendar_sync：45分より前なら503、ちょうど45分なら200", async () => {
    await fresh();
    await setRun("calendar_sync", h.clock.now - CRON_CALENDAR_SYNC_STALE_MS);
    expect((await ready()).status).toBe(200);
    await setRun("calendar_sync", h.clock.now - CRON_CALENDAR_SYNC_STALE_MS - 1);
    expect((await ready()).status).toBe(503);
    expect(degraded()).toEqual([{ event: "health_degraded", reason: "cron_calendar_sync" }]);
    expect(CRON_CALENDAR_SYNC_STALE_MS).toBe(45 * MIN);
  });

  it("outbox：流す型の未処理の最古の行が10分より前なら503、ちょうど10分なら200。処理済みと流さない型では503にならない", async () => {
    await fresh();
    await addOutbox("MeetupLeft", h.clock.now - OUTBOX_BACKLOG_MS - 1, h.clock.now);
    await addOutbox("SomethingElse", h.clock.now - 60 * MIN);
    await addOutbox("MeetupLeft", h.clock.now - OUTBOX_BACKLOG_MS);
    expect((await ready()).status).toBe(200);
    await addOutbox("MeetupLeft", h.clock.now - OUTBOX_BACKLOG_MS - 1);
    expect((await ready()).status).toBe(503);
    expect(degraded()).toEqual([{ event: "health_degraded", reason: "outbox_backlog" }]);
    expect(OUTBOX_BACKLOG_MS).toBe(10 * MIN);
  });

  it("D1 が読めなければ503（reason: db）", async () => {
    const broken = {
      ...h.bindings,
      DB: {
        prepare: () => {
          throw new Error("db down");
        },
      } as unknown as D1Database,
    };
    const res = await h.app.request("/api/v1/health/ready", { headers: { "CF-Connecting-IP": IP } }, broken);
    expect(res.status).toBe(503);
    expect(degraded()).toEqual([{ event: "health_degraded", reason: "db" }]);
  });

  it("503 の本文はどの理由でも同じで、code は unavailable。理由・時刻・件数・利用者IDを含まない", async () => {
    const bodies: unknown[] = [];
    const strip = (b: Record<string, unknown>) => ({ ...b, requestId: "x" });
    // cron_minutely
    await setRun("calendar_sync", h.clock.now);
    let res = await ready();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("application/problem+json");
    bodies.push(strip((await res.json()) as Record<string, unknown>));
    // outbox_backlog
    await fresh();
    await addOutbox("MeetupLeft", h.clock.now - 60 * MIN);
    res = await ready();
    bodies.push(strip((await res.json()) as Record<string, unknown>));
    expect(bodies[0]).toEqual({ type: "about:blank", title: "Service Unavailable", status: 503, code: "unavailable", requestId: "x" });
    expect(bodies[1]).toEqual(bodies[0]);
    expect(JSON.stringify(bodies)).not.toMatch(/cron|outbox|minutely|\d{10,}/);
  });

  it("回数の上限：IP ごとに RL_PUBLIC の health_ready で数え、超えたら429", async () => {
    await fresh();
    h.limiter.allow = () => false;
    const res = await ready();
    expect(res.status).toBe(429);
    expect(h.limiter.calls).toEqual([{ limiter: "RL_PUBLIC", key: `health_ready:ip4:${IP}` }]);
  });
});

describe("ログの重さ", () => {
  it("job_failed・job_dead_lettered は warn で出す。項目は変わらない", async () => {
    const err = vi.spyOn(console, "error");
    const message = (attempts: number) => ({
      body: { kind: "outbox" as const, id: "m1", type: "MeetupLeft", payload: "not-json" },
      attempts,
      ack: vi.fn(),
      retry: vi.fn(),
    });
    await handleBatch(h.ctx, { messages: [message(1), message(6)] } as unknown as MessageBatch<never>);
    const jobs = warns.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => String(l.event).startsWith("job_"));
    expect(jobs).toEqual([
      { event: "job_failed", kind: "outbox", type: "MeetupLeft", id: "m1", attempts: 1, error: "SyntaxError" },
      { event: "job_dead_lettered", kind: "outbox", type: "MeetupLeft", id: "m1", attempts: 6, error: "SyntaxError" },
    ]);
    expect(err).not.toHaveBeenCalled();
  });

  it("unhandled_error は error のまま出す", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.app.get("/api/v1/__boom", () => {
      throw new TypeError("boom");
    });
    const res = await h.request("/api/v1/__boom");
    expect(res.status).toBe(500);
    expect(err.mock.calls.flat().join("\n")).toContain('"event":"unhandled_error"');
  });
});

/** JSONC のコメントを、文字列の中を壊さずに取り除く */
function stripJsonc(text: string) {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
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
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

describe("wrangler の設定", () => {
  it("トップレベルと prod で Workers Issues が有効で、invocation_logs は false のまま", () => {
    type Obs = { enabled: boolean; logs: { invocation_logs: boolean }; issues?: { enabled: boolean } };
    const config = JSON.parse(stripJsonc(wranglerConfig)) as { observability: Obs; env: { prod: { observability?: Obs } } };
    for (const obs of [config.observability, config.env.prod.observability]) {
      expect(obs?.enabled).toBe(true);
      expect(obs?.issues?.enabled).toBe(true);
      expect(obs?.logs.invocation_logs).toBe(false);
    }
  });
});
