import type { AppDeps, Bindings } from "../../env";
import { encryptSecret, fromBase64Url, sha256 } from "../../shared/crypto";
import { pushEndpointOrigin } from "../domain/endpoint";
import * as repo from "../infra/repository";

// プッシュの購読（docs/specs/T-07-notification.md「プッシュの購読と Service Worker」）
// 受け取るのは endpoint と、中身の暗号化の鍵（T-35）だけ。どちらも暗号化して保存し、ログには出さない

type Ctx = { env: Bindings; deps: AppDeps };

export const pushAad = (userId: string) => `push:${userId}`;

/** 暗号化の鍵（p256dh・auth）の AAD。endpoint とは別にし、取り違えて復号できないようにする（T-35） */
export const pushKeysAad = (userId: string) => `push-keys:${userId}`;

/** 鍵の形を確かめる。p256dh は非圧縮の点（65バイト、先頭が 0x04）、auth は16バイト */
function validKeys(keys: { p256dh: string; auth: string }) {
  try {
    const p256dh = fromBase64Url(keys.p256dh);
    const auth = fromBase64Url(keys.auth);
    return p256dh.byteLength === 65 && p256dh[0] === 0x04 && auth.byteLength === 16;
  } catch {
    return false;
  }
}

/**
 * 登録（同じ endpoint は付け替える）。受け付けない宛先・形の違う鍵なら false。
 * 鍵（T-35）は endpoint と同じく暗号化して保存する。鍵のない登録では、その購読の鍵を消す（本文のないプッシュになる）
 */
export async function subscribe(
  ctx: Ctx,
  viewer: { userId: string; sessionId: string },
  endpoint: string,
  keys: { p256dh: string; auth: string } | null,
) {
  if (!pushEndpointOrigin(endpoint, ctx.deps.notification.extraPushHosts)) return false;
  if (keys && !validKeys(keys)) return false;
  const keysEnc = keys
    ? await encryptSecret(
        JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }),
        ctx.env.NOTIFICATION_KEYS,
        ctx.env.NOTIFICATION_CURRENT_KID,
        pushKeysAad(viewer.userId),
      )
    : null;
  await repo.upsertSubscription(ctx.env.DB, {
    userId: viewer.userId,
    sessionId: viewer.sessionId,
    endpointHash: await sha256(endpoint),
    endpointEnc: await encryptSecret(
      endpoint,
      ctx.env.NOTIFICATION_KEYS,
      ctx.env.NOTIFICATION_CURRENT_KID,
      pushAad(viewer.userId),
    ),
    keysEnc,
    now: ctx.deps.now(),
  });
  return true;
}

/** 解除。自分の購読だけを消す（なくても何もしない） */
export async function unsubscribe(ctx: Ctx, viewerId: string, endpoint: string) {
  await repo.deleteSubscription(ctx.env.DB, viewerId, await sha256(endpoint));
}

/** identity から呼ぶ：ログアウト・再利用の検知で、そのセッションの購読を消す */
export async function deleteSubscriptionsOfSession(ctx: Ctx, sessionId: string) {
  await repo.deleteSubscriptionsOfSession(ctx.env.DB, sessionId);
}

/** identity から呼ぶ：全端末ログアウトで、その人の購読をすべて消す */
export async function deleteSubscriptionsOf(ctx: Ctx, userId: string) {
  await repo.deleteSubscriptionsOfUser(ctx.env.DB, userId);
}

/** 1回の掃除で消す購読の数の上限 */
export const PUSH_SUBSCRIPTION_CLEANUP_BATCH = 1000;

/** 15分ごと：失効か期限切れのセッションの購読を消す（docs/specs/T-17-retention.md「9.」）。消した数 */
export async function cleanupDeadSessionSubscriptions(ctx: Ctx) {
  return repo.deleteSubscriptionsOfDeadSessions(ctx.env.DB, ctx.deps.now(), PUSH_SUBSCRIPTION_CLEANUP_BATCH);
}

/** 退会（T-16）：本人の通知の行を消す文。identity の退会の batch に入れる */
export const withdrawalPurgeStatements = (d1: D1Database, userId: string) => repo.withdrawalPurgeStatements(d1, userId);
