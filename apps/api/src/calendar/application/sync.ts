import { calendarCancelStatements, planCalendarCancel, planSize } from "../../availability/application/calendarFacing";
import { decodeBusy, encodeBusy, newlyBusy } from "../domain/busy";
import { ReauthRequired } from "../domain/provider";
import * as repo from "../infra/repository";
import { accessTokenFor, providerFor, type Ctx } from "./connections";

// 定期の確認と自動取り消し（docs/specs/T-06-calendar.md「定期の確認と自動取り消し」決定事項5・6）

const MINUTE_MS = 60 * 1000;
export const SYNC_MIN_AGE_MS = 10 * MINUTE_MS;
export const SYNC_BATCH = 200;
export const SYNC_LEASE_MS = 5 * MINUTE_MS;
export const SYNC_HORIZON_MS = 60 * 24 * 60 * MINUTE_MS;
/** 1回の確認でこれを超えて取り消すときは、1回目を保留にする */
export const MAX_CANCEL_PER_SYNC = 20;

/** Cron（15分ごと）：確認する連携を選び、1人ずつ Queue に送る（outbox には書かない） */
export async function assignSyncs(ctx: Ctx) {
  const due = await repo.connectionsDueForSync(ctx.env.DB, ctx.deps.now(), SYNC_MIN_AGE_MS, SYNC_BATCH);
  for (let i = 0; i < due.length; i += 100) {
    await ctx.env.JOBS.sendBatch(
      due.slice(i, i + 100).map((d) => ({ body: { kind: "calendar_sync" as const, userId: d.user_id, provider: d.provider } })),
    );
  }
  return due.length;
}

export type SyncOutcome = "skipped" | "reauth" | "recorded" | "held" | "synced";

/**
 * 1人の確認。一時的な失敗は投げる（Queue の再試行に任せる）。そのとき記録は更新せず、権利を戻す
 */
export async function syncConnection(ctx: Ctx, userId: string, provider: repo.Provider): Promise<SyncOutcome> {
  const now = ctx.deps.now();
  const row = await repo.takeSyncLease(ctx.env.DB, userId, provider, now, SYNC_LEASE_MS);
  if (!row || row.sync_lease_until === null) return "skipped";
  const lease = row.sync_lease_until;
  const window = { from: now, to: now + SYNC_HORIZON_MS };

  let busy;
  try {
    const accessToken = await accessTokenFor(ctx, row);
    busy = await providerFor(ctx).busy(accessToken, window.from, window.to);
  } catch (e) {
    if (e instanceof ReauthRequired) return "reauth";
    await repo.releaseSyncLease(ctx.env.DB, userId, provider, lease);
    throw e;
  }

  const syncId = crypto.randomUUID();
  const advance = repo.advanceSnapshotStatement(
    ctx.env.DB,
    { userId, provider, lease, syncId },
    { busy: encodeBusy(busy), ...window },
    now,
  );

  // 連携した直後：記録だけを書く（連携した時点の予定ではここ暇を取り消さない）
  if (row.busy_snapshot === null || row.snapshot_from === null || row.snapshot_to === null) {
    await ctx.env.DB.batch([advance]);
    return "recorded";
  }

  const fresh = newlyBusy(
    { busy: decodeBusy(row.busy_snapshot), from: row.snapshot_from, to: row.snapshot_to },
    busy,
  );
  const plan = await planCalendarCancel(ctx, userId, fresh, row.last_synced_at ?? 0);
  const count = planSize(plan);

  // 多すぎる取り消しの1回目は保留にし、記録を進めずに次の確認で判定し直す
  if (count > MAX_CANCEL_PER_SYNC && row.large_change_held !== 1) {
    await repo.holdLargeChange(ctx.env.DB, userId, provider, lease);
    console.log(JSON.stringify({ event: "calendar_sync_held", count }));
    return "held";
  }

  const guard = repo.syncGuard(userId, provider, syncId);
  await ctx.env.DB.batch([advance, ...calendarCancelStatements(ctx, userId, plan, guard)]);
  return "synced";
}
