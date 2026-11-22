import type { AppDeps, Bindings } from "../../env";
import { withdrawalDeleteRefsStatements } from "../../link-preview/application/previews";
import * as repo from "../infra/repository";
import { cancelMeetup, respond } from "./directInvites";

// 退会の後始末の段のうち、誘い・募集・予定（docs/specs/T-16-withdrawal.md「後始末の段」2〜5）
// どの手順も何度呼んでも同じ結果になる。相手への知らせは既存の遷移のイベント（MeetupCancelled・MeetupLeft・
// DirectInviteDeclined）に任せる

type Ctx = { env: Bindings; deps: AppDeps };

/** 1回の処理で、予定・受けた誘いをそれぞれ扱う数の上限 */
export const WITHDRAWAL_BATCH = 100;

/** 上限に当たって残りがある。投げて Queue の再試行で続きを進める */
export class WithdrawalIncomplete extends Error {
  override name = "WithdrawalIncomplete";
}

export async function cleanupInvitationsForWithdrawal(ctx: Ctx, userId: string) {
  const d1 = ctx.env.DB;
  const now = ctx.deps.now();

  // 2. これからの成立した予定：本人の「やっぱり難しい」と同じ（募集の予定は中で抜ける形に振り分けられる）
  const meetups = await repo.upcomingMeetupsToCancel(d1, userId, now, WITHDRAWAL_BATCH);
  for (const id of meetups) await cancelMeetup(ctx, userId, id);

  // 3. 受けた返事待ちの誘い：「今回は難しい」と同じ（送信者に知らせる）
  const received = await repo.receivedPendingInvites(d1, userId, now, WITHDRAWAL_BATCH);
  for (const id of received) await respond(ctx, userId, id, { response: "decline" });

  // 3〜5. 集合の SQL（通知なし）。書いた内容は、参照を先に消してから消す
  await d1.batch([
    ...repo.withdrawalCloseStatements(d1, userId, now),
    ...withdrawalDeleteRefsStatements(d1, userId),
    ...repo.withdrawalEraseContentStatements(d1, userId),
  ]);

  if (meetups.length === WITHDRAWAL_BATCH || received.length === WITHDRAWAL_BATCH) throw new WithdrawalIncomplete();
}
