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

/**
 * 連携を始める。returnMeetupId（UUID として検証済み）は戻り先 /meetups/<id> だけに使い、予定は読まない
 * （参加しているかも確かめない。予定の有無を確かめる手段にしないため。docs/specs/T-57-meetup-google-calendar.md「入力」）
 */
export async function startConnect(ctx: Ctx, viewerId: string, returnMeetupId: string | null = null): Promise<StartResult> {
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
      returnMeetupId,
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

/** 連携の結果と戻り先のパス（APP_ORIGIN の中だけ。docs/specs/T-57-meetup-google-calendar.md「戻り先」） */
export type CompleteResult = { connected: boolean; returnPath: string };

export const SETTINGS_RETURN_PATH = "/settings/calendar";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 保存した予定の ID だけから戻り先を組み立てる（保存の前に検証済みだが、ここでも UUID でなければ設定へ） */
export const returnPathFor = (meetupId: string | null) =>
  meetupId && UUID.test(meetupId) ? `/meetups/${meetupId}` : SETTINGS_RETURN_PATH;

/**
 * 成功か失敗と戻り先を返す（失敗の理由は画面で区別しない。ログには種類だけを出す）。
 * state の行を取り出したあとの想定外の例外も、ここで受けて行の戻り先へ戻す
 */
export async function completeConnect(
  ctx: Ctx,
  params: { code?: string; state?: string; error?: string; binding?: string },
): Promise<CompleteResult> {
  if (!params.state) return failed("state_missing", SETTINGS_RETURN_PATH);
  const now = ctx.deps.now();
  const tx = await repo.takeOauthState(ctx.env.DB, await sha256(params.state), now);
  if (!tx) return failed("state_invalid", SETTINGS_RETURN_PATH);
  const returnPath = returnPathFor(tx.return_meetup_id);
  try {
    const reason = await finishConnect(ctx, params, tx, now);
    return reason === null ? { connected: true, returnPath } : failed(reason, returnPath);
  } catch (e) {
    console.error(JSON.stringify({ event: "calendar_connect_failed", reason: "unexpected", name: e instanceof Error ? e.name : "unknown" }));
    return { connected: false, returnPath };
  }
}

function failed(reason: string, returnPath: string): CompleteResult {
  log("calendar_connect_failed", { reason });
  return { connected: false, returnPath };
}

type OauthState = NonNullable<Awaited<ReturnType<typeof repo.takeOauthState>>>;

/** 取り出した state の行で連携を保存する。成功は null、失敗はその種類（ログ用） */
async function finishConnect(
  ctx: Ctx,
  params: { code?: string; error?: string; binding?: string },
  tx: OauthState,
  now: number,
): Promise<string | null> {
  if (!params.binding || !timingSafeEqual(await sha256(params.binding), tx.binding_hash)) return "binding_mismatch";
  if (params.error || !params.code) return "denied";

  const provider = providerFor(ctx);
  let tokens;
  try {
    tokens = await provider.exchangeCode({
      code: params.code,
      codeVerifier: tx.code_verifier,
      redirectUri: redirectUri(ctx.env),
    });
  } catch {
    return "token_exchange";
  }

  const current = await repo.findConnection(ctx.env.DB, tx.user_id, tx.provider);
  if (!GOOGLE_SCOPES.every((s) => tokens.scopes.includes(s))) {
    // 今の連携が active なら失効させずに捨てる。revoke は同じプロジェクトの許可全体を失効させ、今の連携まで
    // 使えなくするため（決定事項13）
    if (current?.status !== "active") await provider.revoke(tokens.refreshToken);
    return "scope_missing";
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
    return "encrypt";
  }
  // 前の更新用トークンは失効させずに上書きして捨てる（決定事項13）
  const saved = await repo.saveConnection(
    ctx.env.DB,
    { userId: tx.user_id, provider: tx.provider, refreshTokenEnc, now },
    {
      id: crypto.randomUUID(),
      payload: JSON.stringify({ userId: tx.user_id, provider: tx.provider, occurredAt: iso(now) }),
    },
  );
  if (!saved) {
    // 退会と同時に進んでいた callback（T-16）。退会した人の連携は残らないので、受け取った許可を失効させる
    try {
      await provider.revoke(tokens.refreshToken);
    } catch {
      log("calendar_revoke_skipped", {});
    }
    return "user_withdrawn";
  }
  log("calendar_connected", { provider: tx.provider });
  return null;
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

/** 退会（T-16）：本人の .ics の鍵と連携の途中の state を消す文。identity の退会の batch に入れる */
export const withdrawalPurgeStatements = (d1: D1Database, userId: string) => repo.withdrawalPurgeStatements(d1, userId);

/**
 * 退会（T-16 後始末の段）：「ここ暇」カレンダーを消し、更新用トークンを revoke し、連携の行を消す。
 * カレンダーの削除と revoke は失敗しても続ける（行は必ず消す）。何度呼んでも同じ結果になる
 */
export async function purgeCalendarForWithdrawal(ctx: Ctx, userId: string) {
  const conn = await repo.findConnection(ctx.env.DB, userId, "google");
  if (conn?.refresh_token_enc) {
    const provider = providerFor(ctx);
    let refreshToken: string | null = null;
    try {
      refreshToken = await decryptSecret(conn.refresh_token_enc, ctx.env.CALENDAR_TOKEN_KEYS, aadFor(userId, "google"));
    } catch {
      log("calendar_decrypt_failed", { kid: secretKid(conn.refresh_token_enc) });
    }
    if (refreshToken) {
      if (conn.calendar_id) {
        try {
          await provider.deleteCalendar(await provider.accessToken(refreshToken), conn.calendar_id);
        } catch {
          log("calendar_delete_skipped", {});
        }
      }
      try {
        await provider.revoke(refreshToken);
      } catch {
        log("calendar_revoke_skipped", { kid: secretKid(conn.refresh_token_enc) });
      }
    }
  }
  await repo.deleteConnectionsOf(ctx.env.DB, userId);
}
