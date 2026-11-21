import { Hono } from "hono";
import type { AppDeps, AppEnv, Bindings } from "../env";
import { problem } from "../http/problem";
import { rateLimit } from "../http/rateLimit";
import { dispatchedTypes } from "./dispatch";

// 定期処理が動いた記録と、深い死活確認（docs/specs/T-13-monitoring.md「振る舞い」1・2）
// 「ログが出ないこと」（定期処理の停止）は、ログの監視では検知できないので、外の監視サービスがこの API の 503 で見る

type Ctx = { env: Bindings; deps: AppDeps };

export type CronName = "minutely" | "calendar_sync";

const MINUTE_MS = 60 * 1000;
/** 毎分の処理が、これより前から動いていなければ止まっているとみなす */
export const MINUTELY_STALE_MS = 5 * MINUTE_MS;
/** 15分ごとの割り当てが、これより前から動いていなければ止まっているとみなす（3回分の遅れ） */
export const CALENDAR_SYNC_STALE_MS = 45 * MINUTE_MS;
/** 流す型の未処理の outbox の行が、これより前から残っていれば溜まっているとみなす */
export const OUTBOX_BACKLOG_MS = 10 * MINUTE_MS;

/** 定期処理が終わりまで動いた時刻を記録する（途中の処理が失敗していても記録する） */
export async function recordCronRun(d1: D1Database, name: CronName, now: number) {
  await d1
    .prepare(
      `INSERT INTO cron_runs (name, last_run_at) VALUES (?1, ?2)
       ON CONFLICT (name) DO UPDATE SET last_run_at = ?2`,
    )
    .bind(name, now)
    .run();
}

export type DegradedReason = "db" | "cron_minutely" | "cron_calendar_sync" | "outbox_backlog";

/**
 * 死活確認。問題がなければ null、あれば最初に当てはまった理由。読むだけで何も書かず、利用者のデータには触れない
 * （読むのは cron_runs と、流す型の未処理の outbox の最古の created_at だけ）
 */
export async function checkReadiness(ctx: Ctx): Promise<DegradedReason | null> {
  const now = ctx.deps.now();
  let runs: { name: string; last_run_at: number }[];
  let oldest: number | null;
  try {
    const [runRows, outboxRows] = await ctx.env.DB.batch<{ name?: string; last_run_at?: number; oldest?: number | null }>([
      ctx.env.DB.prepare("SELECT name, last_run_at FROM cron_runs"),
      ctx.env.DB.prepare(
        `SELECT MIN(created_at) AS oldest FROM outbox
         WHERE processed_at IS NULL AND type IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(dispatchedTypes(ctx.env))),
    ]);
    runs = (runRows?.results ?? []).flatMap((r) =>
      typeof r.name === "string" && typeof r.last_run_at === "number" ? [{ name: r.name, last_run_at: r.last_run_at }] : [],
    );
    oldest = outboxRows?.results[0]?.oldest ?? null;
  } catch {
    return "db";
  }
  const lastRun = (name: CronName) => runs.find((r) => r.name === name)?.last_run_at;
  const stale = (name: CronName, limit: number) => {
    const at = lastRun(name);
    return at === undefined || at < now - limit;
  };
  if (stale("minutely", MINUTELY_STALE_MS)) return "cron_minutely";
  if (stale("calendar_sync", CALENDAR_SYNC_STALE_MS)) return "cron_calendar_sync";
  if (oldest !== null && oldest < now - OUTBOX_BACKLOG_MS) return "outbox_backlog";
  return null;
}

export function healthRoutes() {
  const app = new Hono<AppEnv>();

  // 認証なし。D1 を読むので IP ごとの上限を付ける。応答には理由・時刻・件数を入れず、どの理由でも同じ本文にする
  app.get("/health/ready", rateLimit({ group: "health_ready", limiter: "RL_PUBLIC", by: "ip" }), async (c) => {
    const reason = await checkReadiness({ env: c.env, deps: c.var.deps });
    if (reason === null) {
      c.header("Cache-Control", "no-store");
      return c.json({ status: "ok" });
    }
    // 理由はログにだけ出す（想定した状態の知らせなので warn。docs/specs/T-13-monitoring.md「ログの追加と、重さの見直し」）
    console.warn(JSON.stringify({ event: "health_degraded", reason }));
    const res = problem(c.get("requestId"), 503, "unavailable", "Service Unavailable");
    res.headers.set("Cache-Control", "no-store");
    return res;
  });

  return app;
}
