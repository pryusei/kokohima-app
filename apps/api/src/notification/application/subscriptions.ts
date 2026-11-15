import type { AppDeps, Bindings } from "../../env";
import { encryptSecret, sha256 } from "../../shared/crypto";
import { pushEndpointOrigin } from "../domain/endpoint";
import * as repo from "../infra/repository";

// プッシュの購読（docs/specs/T-07-notification.md「プッシュの購読と Service Worker」）
// 受け取るのは endpoint だけ。暗号化して保存し、ログには出さない

type Ctx = { env: Bindings; deps: AppDeps };

export const pushAad = (userId: string) => `push:${userId}`;

/** 登録（同じ endpoint は付け替える）。受け付けない宛先なら false */
export async function subscribe(ctx: Ctx, viewer: { userId: string; sessionId: string }, endpoint: string) {
  if (!pushEndpointOrigin(endpoint, ctx.deps.notification.extraPushHosts)) return false;
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
