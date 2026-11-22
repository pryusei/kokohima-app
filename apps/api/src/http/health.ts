import type { Context } from "hono";
import type { AppEnv } from "../env";
import { dispatchedTypes } from "../jobs/dispatch";
import { problem } from "./problem";

// 深い死活確認（docs/specs/T-13-monitoring.md「深い死活確認」）。外の監視サービスが確かめる。
// 読むだけで書かない。利用者のデータには触れない。503 の本文はどの理由でも同じにし、理由はログにだけ出す

const MINUTE_MS = 60 * 1000;
/** これより前なら止まっているとみなす（ちょうどは止まっていない） */
export const CRON_MINUTELY_STALE_MS = 5 * MINUTE_MS;
export const CRON_CALENDAR_SYNC_STALE_MS = 45 * MINUTE_MS;
export const OUTBOX_BACKLOG_MS = 10 * MINUTE_MS;

export type HealthReason = "db" | "cron_minutely" | "cron_calendar_sync" | "outbox_backlog";

/** 当てはまる理由（表の上から最初の1つ）。なければ null */
export async function healthReason(d1: D1Database, now: number, types: readonly string[]): Promise<HealthReason | null> {
  let runs: Map<string, number>;
  let oldest: number | null;
  try {
    const [cron, backlog] = await d1.batch([
      d1.prepare("SELECT name, last_run_at FROM cron_runs"),
      // 既存のインデックス outbox_unprocessed (processed_at, created_at) で読む
      d1.prepare(
        `SELECT MIN(created_at) AS oldest FROM outbox
         WHERE processed_at IS NULL AND type IN (SELECT value FROM json_each(?1))`,
      ).bind(JSON.stringify(types)),
    ]);
    runs = new Map(((cron?.results ?? []) as { name: string; last_run_at: number }[]).map((r) => [r.name, r.last_run_at]));
    oldest = ((backlog?.results ?? [])[0] as { oldest: number | null } | undefined)?.oldest ?? null;
  } catch {
    return "db";
  }
  const stale = (name: string, limit: number) => {
    const at = runs.get(name);
    return at === undefined || at < now - limit;
  };
  if (stale("minutely", CRON_MINUTELY_STALE_MS)) return "cron_minutely";
  if (stale("calendar_sync", CRON_CALENDAR_SYNC_STALE_MS)) return "cron_calendar_sync";
  if (oldest !== null && oldest < now - OUTBOX_BACKLOG_MS) return "outbox_backlog";
  return null;
}

export async function healthReady(c: Context<AppEnv>) {
  const reason = await healthReason(c.env.DB, c.var.deps.now(), dispatchedTypes(c.env));
  if (reason) {
    console.warn(JSON.stringify({ event: "health_degraded", reason }));
    const res = problem(c.get("requestId"), 503, "unavailable", "Service Unavailable");
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  c.header("Cache-Control", "no-store");
  return c.json({ status: "ok" });
}
