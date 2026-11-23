import * as repo from "../infra/repository";
import type { Ctx } from "./connections";

// 休眠中の連携（docs/specs/T-17-retention.md「8.」）。30日アプリを開いていない人の連携は、定期の確認を止め、埋まりの記録を消す。
// Google の許可（更新用トークン）は残す。ログインし直したら、新しく連携したときと同じく「記録だけ」から始める

const DAY_MS = 24 * 60 * 60 * 1000;
/** 最後に使ってからこれを過ぎ、使える更新用トークンがなければ休眠にする */
export const DORMANT_AFTER_MS = 30 * DAY_MS;
/** 15分ごとの Cron で、1回に休眠にする・戻す行の数の上限 */
export const DORMANCY_BATCH = 100;

/** 15分ごと：休眠にする。休眠にした数 */
export async function markDormantConnections(ctx: Ctx) {
  const now = ctx.deps.now();
  return repo.markDormantConnections(ctx.env.DB, now, now - DORMANT_AFTER_MS, DORMANCY_BATCH);
}

/** 15分ごと：休眠のままの取りこぼし（使えるトークンがあり、最後に使ってから30日以内）を戻す。戻した数 */
export async function wakeDormantConnections(ctx: Ctx) {
  const now = ctx.deps.now();
  return repo.wakeDormantConnections(ctx.env.DB, now, now - DORMANT_AFTER_MS, DORMANCY_BATCH);
}

/** ログインでセッションを作る batch（identity）に入れる文。そのセッションの利用者（本人）の連携だけを戻す */
export const wakeConnectionsStatement = (d1: D1Database, userId: string, sessionId: string, now: number) =>
  repo.wakeConnectionsStatement(d1, userId, sessionId, now);
