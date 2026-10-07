import type { CreateInviteLinkRequest } from "@kokohima/shared";
import { getSharingFor, setSharing } from "../../availability/application/sharing";
import type { AppDeps, Bindings } from "../../env";
import { getPublicProfiles } from "../../identity/application/auth";
import { decodeCursor, encodeCursor } from "../../shared/cursor";
import { randomToken, sha256 } from "../../shared/crypto";
import { DAY_MS, expiresAt, isUsable, ISSUE_LIMIT_PER_DAY, issueRetryAfterSeconds } from "../domain/inviteLink";
import * as repo from "../infra/repository";

// 友達と招待リンクのユースケース（docs/specs/T-02-friends.md「振る舞い」）
// 閲覧者IDは呼び出し側（requireAuth）から受け取り、body・query のユーザーIDは使わない

type Ctx = { env: Bindings; deps: AppDeps };


const iso = (ms: number) => new Date(ms).toISOString();

export class BadCursor extends Error {}

function parseCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const parsed = decodeCursor(cursor);
  if (!parsed) throw new BadCursor();
  return parsed;
}

export type CreateInviteResult =
  | { kind: "created"; link: { id: string; url: string; expiresAt: string; maxUses: number; uses: number; createdAt: string } }
  | { kind: "display_name_required" }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export async function createInviteLink(
  ctx: Ctx,
  viewerId: string,
  options: Required<CreateInviteLinkRequest>,
): Promise<CreateInviteResult> {
  const now = ctx.deps.now();
  const db = repo.db(ctx.env.DB);
  const me = (await getPublicProfiles(ctx.env, [viewerId])).get(viewerId);
  if (!me?.displayName) return { kind: "display_name_required" };

  const since = now - DAY_MS;
  const rateLimited = async () => ({
    kind: "rate_limited" as const,
    retryAfterSeconds: issueRetryAfterSeconds(await repo.recentInviteCreatedAts(db, viewerId, since), now) ?? 1,
  });
  if (issueRetryAfterSeconds(await repo.recentInviteCreatedAts(db, viewerId, since), now) !== null) return rateLimited();

  const token = randomToken();
  const id = crypto.randomUUID();
  const exp = expiresAt(now, options.expiresInDays);
  // 上限の判定と追加は1つの文で行う（同時に送られても20本を超えない）
  const inserted = await repo.insertInviteLinkWithinLimit(
    db,
    { id, ownerId: viewerId, tokenHash: await sha256(token), maxUses: options.maxUses, uses: 0, expiresAt: exp, createdAt: now },
    since,
    ISSUE_LIMIT_PER_DAY,
  );
  if (!inserted) return rateLimited();
  return {
    kind: "created",
    link: {
      id,
      // トークンはフラグメントに入れる（サーバーのログやRefererに残さない）
      url: `${ctx.env.APP_ORIGIN}/invite#t=${token}`,
      expiresAt: iso(exp),
      maxUses: options.maxUses,
      uses: 0,
      createdAt: iso(now),
    },
  };
}

export async function listInviteLinks(ctx: Ctx, viewerId: string, limit: number, cursor: string | undefined) {
  const rows = await repo.listUsableInviteLinks(repo.db(ctx.env.DB), viewerId, ctx.deps.now(), limit, parseCursor(cursor));
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      id: r.id,
      expiresAt: iso(r.expiresAt),
      maxUses: r.maxUses,
      uses: r.uses,
      createdAt: iso(r.createdAt),
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ k: last.createdAt, id: last.id }) : null,
  };
}

export async function revokeInviteLink(ctx: Ctx, viewerId: string, id: string) {
  return repo.revokeOwnInviteLink(repo.db(ctx.env.DB), viewerId, id, ctx.deps.now());
}

/** 使えるリンクなら発行者の公開プロフィールを返す。理由にかかわらず使えなければ null */
export async function lookupInvite(ctx: Ctx, token: string | undefined) {
  if (!token || token.length > 128) return null;
  const link = await repo.findInviteLinkByTokenHash(repo.db(ctx.env.DB), await sha256(token));
  if (!link || !isUsable(link, ctx.deps.now())) return null;
  const inviter = (await getPublicProfiles(ctx.env, [link.ownerId])).get(link.ownerId);
  if (!inviter) return null;
  return { linkId: link.id, inviter: { displayName: inviter.displayName, avatarUrl: inviter.avatarUrl } };
}

export type AcceptResult =
  | { kind: "created" | "already_friends"; friend: { id: string; displayName: string | null; avatarUrl: string | null } }
  /** keepCookie：表示したリンクと招待Cookieのリンクが違う（別のタブで上書きされた）ので、Cookieは消さない */
  | { kind: "not_found"; keepCookie?: boolean }
  | { kind: "own_link" };

/** 「友達になる」の手順（仕様書の手順1〜4） */
export async function acceptInvite(
  ctx: Ctx,
  viewerId: string,
  token: string | undefined,
  linkId: string,
): Promise<AcceptResult> {
  if (!token || token.length > 128) return { kind: "not_found" };
  const now = ctx.deps.now();
  const db = repo.db(ctx.env.DB);

  // 1. 招待Cookieのリンク。使えなければ理由にかかわらず404
  const link = await repo.findInviteLinkByTokenHash(db, await sha256(token));
  if (!link || !isUsable(link, now)) return { kind: "not_found" };
  // 2. 画面に表示したリンクと同じか（別のタブで招待Cookieが上書きされた場合）
  if (link.id !== linkId) return { kind: "not_found", keepCookie: true };
  // 3. 自分のリンク
  if (link.ownerId === viewerId) return { kind: "own_link" };

  const inviter = (await getPublicProfiles(ctx.env, [link.ownerId])).get(link.ownerId);
  if (!inviter) return { kind: "not_found" };

  // 4. 人数の消費・両方向の行・イベントを1つのバッチで書く
  const outcome = await repo.acceptInBatch(ctx.env.DB, {
    linkId: link.id,
    inviterId: link.ownerId,
    acceptorId: viewerId,
    now,
  });
  if (outcome === "unusable") return { kind: "not_found" };
  return { kind: outcome === "created" ? "created" : "already_friends", friend: inviter };
}

export async function listFriends(ctx: Ctx, viewerId: string, limit: number, cursor: string | undefined) {
  const db = repo.db(ctx.env.DB);
  const rows = await repo.listFriends(db, viewerId, limit, parseCursor(cursor));
  const page = rows.slice(0, limit);
  const ids = page.map((r) => r.friendId);
  // 公開設定は availability の関数を通して1回で取る（SQLのJOINはしない）
  const [profiles, sharing] = await Promise.all([
    getPublicProfiles(ctx.env, ids),
    getSharingFor(ctx.env.DB, viewerId, ids),
  ]);
  const last = page.at(-1);
  return {
    items: page.flatMap((r) => {
      const p = profiles.get(r.friendId);
      if (!p) return [];
      return [
        {
          id: p.id,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
          sharesMyAvailability: sharing.get(r.friendId) ?? true,
          friendsSince: iso(r.createdAt),
        },
      ];
    }),
    nextCursor: rows.length > limit && last ? encodeCursor({ k: last.createdAt, id: last.friendId }) : null,
  };
}

/** 友達のときだけ公開設定を変える。友達でなければ null */
export async function updateFriend(ctx: Ctx, viewerId: string, friendId: string, sharesMyAvailability: boolean) {
  const db = repo.db(ctx.env.DB);
  const friendship = await repo.findFriendship(db, viewerId, friendId);
  if (!friendship) return null;
  await setSharing(ctx.env.DB, viewerId, friendId, sharesMyAvailability, ctx.deps.now());
  const profile = (await getPublicProfiles(ctx.env, [friendId])).get(friendId);
  if (!profile) return null;
  return {
    id: profile.id,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    sharesMyAvailability,
    friendsSince: iso(friendship.createdAt),
  };
}

/** 静かに解除する（通知なし、outboxにも書かない）。友達でなければ false */
export async function unfriend(ctx: Ctx, viewerId: string, friendId: string) {
  const db = repo.db(ctx.env.DB);
  if (!(await repo.findFriendship(db, viewerId, friendId))) return false;
  await repo.deleteFriendship(db, viewerId, friendId);
  return true;
}
