import { withdrawalPurgeStatements as availabilityPurge } from "../../availability/application/availability";
import { withdrawalPurgeSharingStatements } from "../../availability/application/sharing";
import {
  purgeCalendarForWithdrawal,
  withdrawalPurgeStatements as calendarPurge,
} from "../../calendar/application/connections";
import type { AppDeps, Bindings, Viewer } from "../../env";
import { cleanupInvitationsForWithdrawal } from "../../invitation/application/withdrawal";
import { withdrawalPurgeStatements as notificationPurge } from "../../notification/application/subscriptions";
import { withdrawalPurgeIdempotencyStatements } from "../../shared/idempotency";
import { withdrawalPurgeStatements as socialPurge } from "../../social/application/social";
import { withdrawalPurgeStatements as wishSuggestionPurge } from "../../wish/application/suggestions";
import { withdrawalPurgeStatements as wishPurge } from "../../wish/application/wishes";
import * as repo from "../infra/repository";

// 退会（docs/specs/T-16-withdrawal.md）。2段に分ける：
// 入口を止める段（要求の中の1つの batch）と、後始末の段（outbox の UserWithdrew を consumer で処理）

type Ctx = { env: Bindings; deps: AppDeps };

/** 直前のログイン：セッションのログインから、これより長くたっていたら、ログインし直してもらう */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;
/** 後始末が終わっていなければ、毎分の掃除で呼び直す（退会からの時間と、1回に呼ぶ人数） */
export const WITHDRAWAL_RETRY_AFTER_MS = 60 * 60 * 1000;
export const WITHDRAWAL_RETRY_LIMIT = 5;

/** ログインし直しに使える方法。それ以外（E2E のテスト用ログインなど）は null で返し、画面はログインの画面へ移す */
const REAUTH_PROVIDERS = ["google", "apple"] as const;
export type ReauthProvider = (typeof REAUTH_PROVIDERS)[number];

export type WithdrawResult =
  | { kind: "ok" }
  | { kind: "unauthenticated" }
  | { kind: "reauth_required"; provider: ReauthProvider | null };

/** 入口を止める段。閲覧者本人だけを退会させる */
export async function withdraw(ctx: Ctx, viewer: Viewer): Promise<WithdrawResult> {
  const now = ctx.deps.now();
  const db = repo.db(ctx.env.DB);
  const loginAt = await repo.activeSessionCreatedAt(db, viewer, now);
  if (loginAt === null) return { kind: "unauthenticated" };
  if (now - loginAt > REAUTH_WINDOW_MS) {
    // 同じ方法でログインし直してもらう（別の方法は別の利用者になる。F-01）
    const provider = await repo.identityProviderOf(ctx.env.DB, viewer.userId);
    return { kind: "reauth_required", provider: REAUTH_PROVIDERS.find((p) => p === provider) ?? null };
  }
  const d1 = ctx.env.DB;
  const userId = viewer.userId;
  await d1.batch([
    // 最初に抜け殻にする（同時に進む要求は、ここから先 withdrawn_at の条件で止まる）
    ...repo.withdrawalStatements(d1, userId, now),
    ...socialPurge(d1, userId),
    ...withdrawalPurgeSharingStatements(d1, userId),
    // 行きたい（T-22）：友達の行と同じ batch で消し、後始末を待たずに見えなくする
    ...wishPurge(d1, userId),
    // 行きたいのAI提案の回数の記録（T-29）：つながりを切る（全体の上限の数には残す）
    ...wishSuggestionPurge(d1, userId),
    ...availabilityPurge(d1, userId),
    ...notificationPurge(d1, userId),
    ...withdrawalPurgeIdempotencyStatements(d1, userId),
    ...calendarPurge(d1, userId),
  ]);
  console.info(JSON.stringify({ event: "user_withdrew" }));
  return { kind: "ok" };
}

/**
 * 後始末の段（consumer の UserWithdrew と、毎分の掃除から）。どの手順も冪等。失敗したら投げて再試行に任せる。
 * 退会していない人には何もしない
 */
export async function completeWithdrawal(ctx: Ctx, userId: string) {
  if (!(await repo.isWithdrawn(ctx.env.DB, userId))) return;
  await purgeCalendarForWithdrawal(ctx, userId);
  await cleanupInvitationsForWithdrawal(ctx, userId);
  await repo.markWithdrawalCompleted(ctx.env.DB, userId, ctx.deps.now());
}

/** 毎分の掃除：退会から1時間を過ぎて終わっていない後始末を、1回に5人まで呼び直す。失敗は次の回に任せる */
export async function retryIncompleteWithdrawals(ctx: Ctx) {
  const ids = await repo.incompleteWithdrawals(ctx.env.DB, ctx.deps.now() - WITHDRAWAL_RETRY_AFTER_MS, WITHDRAWAL_RETRY_LIMIT);
  for (const id of ids) {
    try {
      await completeWithdrawal(ctx, id);
    } catch (e) {
      console.warn(JSON.stringify({ event: "withdrawal_retry_failed", error: e instanceof Error ? e.name : "unknown" }));
    }
  }
}
