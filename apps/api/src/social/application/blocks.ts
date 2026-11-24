import type { SafetySubject } from "@kokohima/shared";
import { unfriendPurgeSharingStatements } from "../../availability/application/sharing";
import type { AppDeps, Bindings } from "../../env";
import { getHistoryProfiles } from "../../identity/application/auth";
import { receivedSubjectOf, type ReceivedSubject } from "../../invitation/application/safetyFacing";
import { decodeCursor, encodeCursor } from "../../shared/cursor";
import * as repo from "../infra/repository";

// ブロック（docs/specs/T-33-block-report.md「振る舞い 1.」〜「3.」）。閲覧者 ID は requireAuth から受け取り、body の ID は「相手を探すキー」にだけ使う

type Ctx = { env: Bindings; deps: AppDeps };

export class BadCursor extends Error {}

/**
 * ブロック・通報できる相手か（「振る舞い 1.」）。できなければ null。
 * - subject がなければ、閲覧者側の友達の行がある相手
 * - subject があれば、その誘い・募集を閲覧者が受け取っていて、送り主が userId のとき（友達でなくなっていてもよい）
 * 自分自身はいつも null。関係のない人・存在しない人・送った側の誘いは、どれも同じ null
 */
export async function actionableTarget(
  ctx: Ctx,
  viewerId: string,
  userId: string,
  subject: SafetySubject | undefined,
): Promise<{ subject: ReceivedSubject | null } | null> {
  if (userId === viewerId) return null;
  if (subject) {
    const found = await receivedSubjectOf(ctx, viewerId, subject);
    return found && found.senderId === userId ? { subject: found } : null;
  }
  const friendship = await repo.findFriendship(repo.db(ctx.env.DB), viewerId, userId);
  return friendship ? { subject: null } : null;
}

/** ブロックの書き込み（相手を確かめたあと）。友達の解除と同じ文（両方向の友達の行・「見せる」の公開設定）を同じ batch で消す */
export async function blockConfirmed(ctx: Ctx, viewerId: string, userId: string) {
  await repo.blockInBatch(ctx.env.DB, viewerId, userId, ctx.deps.now(), unfriendPurgeSharingStatements(ctx.env.DB, viewerId, userId));
}

/** POST /blocks。相手を確かめられなければ false（404）。すでにブロックしていても true（最初の時刻のまま） */
export async function block(ctx: Ctx, viewerId: string, userId: string, subject: SafetySubject | undefined) {
  if (!(await actionableTarget(ctx, viewerId, userId, subject))) {
    // 友達でなくなったあと（ブロックしたあとを含む）に、もう一度同じ相手を送ってきたときは、すでにある行を確かめる
    return repo.hasOwnBlock(ctx.env.DB, viewerId, userId);
  }
  await blockConfirmed(ctx, viewerId, userId);
  return true;
}

/** DELETE /blocks/{userId}。閲覧者のブロックがなければ false（404）。友達には戻さない */
export async function unblock(ctx: Ctx, viewerId: string, userId: string) {
  return repo.deleteOwnBlock(ctx.env.DB, viewerId, userId);
}

/** GET /blocks。相手は履歴の相手のプロフィール（退会したら withdrawn。アイコンは友達でないので null） */
export async function listBlocked(ctx: Ctx, viewerId: string, limit: number, cursor: string | undefined) {
  let parsed = null;
  if (cursor !== undefined) {
    parsed = decodeCursor(cursor);
    if (!parsed) throw new BadCursor();
  }
  const rows = await repo.listBlocks(ctx.env.DB, viewerId, limit, parsed);
  const page = rows.slice(0, limit);
  const profiles = await getHistoryProfiles(ctx, viewerId, page.map((r) => r.blockedId));
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      user: profiles.get(r.blockedId) ?? { id: r.blockedId, displayName: null, avatarUrl: null, withdrawn: true },
      blockedAt: new Date(r.createdAt).toISOString(),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ k: last.createdAt, id: last.blockedId }) : null,
  };
}

/** 招待リンク（lookup・accept）向け：どちらかの向きにブロックがあるか */
export const isBlockedBetween = (ctx: Ctx, a: string, b: string) => repo.isBlockedEitherWay(ctx.env.DB, a, b);
