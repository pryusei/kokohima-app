import type { CalendarConnections } from "@kokohima/shared";
import type { AppDeps, Bindings } from "../../env";
import { decryptSecret, encryptSecret, pkceChallenge, randomToken, secretKid, sha256, timingSafeEqual } from "../../shared/crypto";
import { ProviderUnavailable, ReauthRequired, type CalendarProvider } from "../domain/provider";
import { GOOGLE_SCOPES, googleProvider } from "../infra/google/provider";
import * as repo from "../infra/repository";

// カレンダー連携の開始・コールバック・状態・解除（docs/specs/T-06-calendar.md「振る舞い」）
// 閲覧者は requireAuth（コールバックは state に結びつけた利用者）から受け取る。トークン・コードはログに出さない

export type Ctx = { env: Bindings; deps: AppDeps };

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_START_LIMIT = 10;

export const providerFor = (ctx: Ctx): CalendarProvider => googleProvider(ctx.env, ctx.deps);
export const redirectUri = (env: Bindings) => `${env.APP_ORIGIN}/api/v1/calendar/google/callback`;
const aadFor = (userId: string, provider: repo.Provider) => `calendar:${provider}:${userId}`;
const iso = (ms: number) => new Date(ms).toISOString();

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

// ---- 連携の開始 ----

export type StartResult =
  | { kind: "ok"; authorizeUrl: string; binding: string }
  | { kind: "rate_limited"; retryAfterSeconds: number };

export async function startConnect(ctx: Ctx, viewerId: string): Promise<StartResult> {
  const now = ctx.deps.now();
  const state = randomToken();
  const binding = randomToken();
  const codeVerifier = randomToken();
  const inserted = await repo.insertOauthStateWithinLimit(
    ctx.env.DB,
    {
      stateHash: await sha256(state),
      bindingHash: await sha256(binding),
      userId: viewerId,
      provider: "google",
      codeVerifier,
      now,
    },
    OAUTH_STATE_TTL_MS,
    OAUTH_START_LIMIT,
  );
  if (!inserted) {
    const oldest = await repo.oldestOauthState(ctx.env.DB, viewerId, now - OAUTH_STATE_TTL_MS);
    const retryAfterMs = oldest === null ? OAUTH_STATE_TTL_MS : oldest + OAUTH_STATE_TTL_MS - now;
    return { kind: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
  }
  const authorizeUrl = providerFor(ctx).authorizeUrl({
    state,
    codeChallenge: await pkceChallenge(codeVerifier),
    redirectUri: redirectUri(ctx.env),
  });
  return { kind: "ok", authorizeUrl, binding };
}

// ---- コールバック ----

/** 成功か失敗だけを返す（失敗の理由は画面で区別しない。ログには種類だけを出す） */
export async function completeConnect(
  ctx: Ctx,
  params: { code?: string; state?: string; error?: string; binding?: string },
): Promise<boolean> {
  const fail = (reason: string) => {
    log("calendar_connect_failed", { reason });
    return false;
  };
  if (!params.state) return fail("state_missing");
  const now = ctx.deps.now();
  const tx = await repo.takeOauthState(ctx.env.DB, await sha256(params.state), now);
  if (!tx) return fail("state_invalid");
  if (!params.binding || !timingSafeEqual(await sha256(params.binding), tx.binding_hash)) {
    return fail("binding_mismatch");
  }
  if (params.error || !params.code) return fail("denied");

  const provider = providerFor(ctx);
  let tokens;
  try {
    tokens = await provider.exchangeCode({
      code: params.code,
      codeVerifier: tx.code_verifier,
      redirectUri: redirectUri(ctx.env),
    });
  } catch {
    return fail("token_exchange");
  }

  const current = await repo.findConnection(ctx.env.DB, tx.user_id, tx.provider);
  if (!GOOGLE_SCOPES.every((s) => tokens.scopes.includes(s))) {
    // 今の連携が active なら失効させずに捨てる。revoke は同じプロジェクトの許可全体を失効させ、今の連携まで
    // 使えなくするため（決定事項13）
    if (current?.status !== "active") await provider.revoke(tokens.refreshToken);
    return fail("scope_missing");
  }

  let refreshTokenEnc: string;
  try {
    refreshTokenEnc = await encryptSecret(
      tokens.refreshToken,
      ctx.env.CALENDAR_TOKEN_KEYS,
      ctx.env.CALENDAR_TOKEN_CURRENT_KID,
      aadFor(tx.user_id, tx.provider),
    );
  } catch {
    return fail("encrypt");
  }
  // 前の更新用トークンは失効させずに上書きして捨てる（決定事項13）
  await repo.saveConnection(
    ctx.env.DB,
    { userId: tx.user_id, provider: tx.provider, refreshTokenEnc, now },
    {
      id: crypto.randomUUID(),
      payload: JSON.stringify({ userId: tx.user_id, provider: tx.provider, occurredAt: iso(now) }),
    },
  );
  log("calendar_connected", { provider: tx.provider });
  return true;
}

// ---- 状態と解除 ----

export async function getConnections(ctx: Ctx, viewerId: string): Promise<CalendarConnections> {
  const row = await repo.findConnection(ctx.env.DB, viewerId, "google");
  if (!row || row.status === "disconnected") return { google: { status: "none", connectedAt: null } };
  return {
    google: {
      status: row.status === "active" ? "connected" : "needs_reauth",
      connectedAt: iso(row.connected_at),
    },
  };
}

/** 解除。連携していなければ false。Google の失効は試みるだけで、保存したトークンは必ず消す */
export async function disconnectGoogle(ctx: Ctx, viewerId: string): Promise<boolean> {
  const token = await repo.disconnect(ctx.env.DB, viewerId, "google", ctx.deps.now());
  if (token === undefined) return false;
  if (token) {
    try {
      const plain = await decryptSecret(token, ctx.env.CALENDAR_TOKEN_KEYS, aadFor(viewerId, "google"));
      await providerFor(ctx).revoke(plain);
    } catch {
      log("calendar_revoke_skipped", { kid: secretKid(token) });
    }
  }
  return true;
}

// ---- アクセストークン ----

/**
 * 連携の行からアクセストークンを取る。Google 側で失効していたら needs_reauth にして ReauthRequired を投げる。
 * 知らない鍵ID・一時的な失敗は ProviderUnavailable（連携は壊さない）
 */
export async function accessTokenFor(ctx: Ctx, row: repo.ConnectionRow): Promise<string> {
  if (row.status !== "active" || !row.refresh_token_enc) throw new ReauthRequired();
  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(row.refresh_token_enc, ctx.env.CALENDAR_TOKEN_KEYS, aadFor(row.user_id, row.provider));
  } catch {
    log("calendar_decrypt_failed", { kid: secretKid(row.refresh_token_enc) });
    throw new ProviderUnavailable("decrypt");
  }
  try {
    return await providerFor(ctx).accessToken(refreshToken);
  } catch (e) {
    if (e instanceof ReauthRequired) {
      const now = ctx.deps.now();
      await repo.markNeedsReauth(
        ctx.env.DB,
        row.user_id,
        row.provider,
        {
          id: crypto.randomUUID(),
          payload: JSON.stringify({ userId: row.user_id, provider: row.provider, occurredAt: iso(now) }),
        },
        now,
      );
      log("calendar_reauth_required", { provider: row.provider });
    }
    throw e;
  }
}
