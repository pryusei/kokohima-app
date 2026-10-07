import type { AppDeps, Bindings, Viewer } from "../../env";
import { randomToken, sha256, timingSafeEqual } from "../../shared/crypto";
import { deviceSummary } from "../domain/deviceSummary";
import { type Provider, verifiedEmail } from "../domain/idTokenClaims";
import { decideRefresh, nextTokenExpiry, SESSION_TTL_MS } from "../domain/refresh";
import { sanitizeReturnTo } from "../domain/returnTo";
import { issueAccessToken } from "../infra/accessToken";
import { authorizeUrl, exchangeCode, LoginFailed, type OidcProviderName } from "../infra/oidc";
import * as repo from "../infra/repository";

// 認証のユースケース（docs/specs/T-01-auth.md「振る舞い」）

export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_TTL_MS = 60 * 1000;

type Ctx = { env: Bindings; deps: AppDeps };

export type IssuedSession = {
  refreshToken: string;
  refreshExpiresAt: number;
  accessToken: string;
  expiresAt: string;
};

export async function startLogin(ctx: Ctx, provider: OidcProviderName, returnTo: string | undefined) {
  const now = ctx.deps.now();
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();
  const binding = randomToken();
  await repo.saveOauthTransaction(repo.db(ctx.env.DB), {
    stateHash: await sha256(state),
    provider,
    nonce,
    codeVerifier,
    bindingHash: await sha256(binding),
    returnTo: sanitizeReturnTo(returnTo, ctx.env.APP_ORIGIN),
    expiresAt: now + OAUTH_TX_TTL_MS,
  });
  const redirectUrl = await authorizeUrl(ctx.env, provider, { state, nonce, codeVerifier });
  return { redirectUrl, binding };
}

/** 成功すれば完了コードを返す。失敗の理由は呼び出し側に区別させない（ログには種類だけを出す） */
export async function handleCallback(
  ctx: Ctx,
  provider: OidcProviderName,
  params: { code?: string; state?: string; error?: string },
  bindingCookie: string | undefined,
): Promise<string | null> {
  try {
    const now = ctx.deps.now();
    const db = repo.db(ctx.env.DB);
    if (params.error) throw new LoginFailed("provider_error");
    if (!params.code || !params.state) throw new LoginFailed("missing_params");
    if (params.code.length > 2048 || params.state.length > 128) throw new LoginFailed("params_too_long");

    const tx = await repo.takeOauthTransaction(db, await sha256(params.state), now);
    if (!tx || tx.provider !== provider) throw new LoginFailed("state_invalid");
    if (!bindingCookie || !timingSafeEqual(await sha256(bindingCookie), tx.bindingHash)) {
      throw new LoginFailed("binding_mismatch");
    }

    const claims = await exchangeCode(ctx.env, ctx.deps, provider, {
      code: params.code,
      codeVerifier: tx.codeVerifier,
      nonce: tx.nonce,
    });
    const userId = await repo.findOrCreateUser(
      db,
      provider,
      claims.sub,
      verifiedEmail(provider, claims),
      ctx.deps.now(),
    );

    const loginCode = randomToken();
    await repo.saveLoginCode(db, {
      codeHash: await sha256(loginCode),
      userId,
      provider,
      bindingHash: tx.bindingHash,
      returnTo: tx.returnTo,
      expiresAt: ctx.deps.now() + LOGIN_CODE_TTL_MS,
    });
    return loginCode;
  } catch (err) {
    const reason = err instanceof LoginFailed ? err.reason : "unexpected";
    console.warn(JSON.stringify({ event: "login_failed", provider, reason }));
    return null;
  }
}

/** 完了コードと結びつけCookieを照合してセッションを作る。失敗は null（理由を区別しない） */
export async function completeLogin(
  ctx: Ctx,
  code: string,
  bindingCookie: string | undefined,
  userAgent: string | undefined,
): Promise<(IssuedSession & { returnTo: string }) | null> {
  const now = ctx.deps.now();
  const db = repo.db(ctx.env.DB);
  const row = await repo.takeLoginCode(db, await sha256(code), now);
  if (!row) return null;
  if (!bindingCookie || !timingSafeEqual(await sha256(bindingCookie), row.bindingHash)) return null;
  const issued = await createSession(ctx, row.userId, row.provider as Provider, userAgent);
  return { ...issued, returnTo: sanitizeReturnTo(row.returnTo, ctx.env.APP_ORIGIN) };
}

/** 新しいセッション（更新用トークンの系列）を作る。通常のログインとE2E用のログインで共有する */
export async function createSession(
  ctx: Ctx,
  userId: string,
  provider: Provider,
  userAgent: string | undefined,
): Promise<IssuedSession> {
  const now = ctx.deps.now();
  const sessionId = crypto.randomUUID();
  const sessionExpiresAt = now + SESSION_TTL_MS;
  const refreshToken = randomToken();
  const refreshExpiresAt = nextTokenExpiry(now, sessionExpiresAt);
  await repo.createSessionRows(repo.db(ctx.env.DB), {
    sessionId,
    userId,
    tokenHash: await sha256(refreshToken),
    tokenExpiresAt: refreshExpiresAt,
    sessionExpiresAt,
    event: {
      userId,
      sessionId,
      provider,
      deviceSummary: deviceSummary(userAgent),
      occurredAt: new Date(now).toISOString(),
    },
    now,
  });
  const access = await issueAccessToken(ctx.env, { userId, sessionId }, now);
  return { refreshToken, refreshExpiresAt, ...access };
}

export type RefreshResult = { kind: "ok"; session: IssuedSession } | { kind: "unauthenticated" };

export async function refresh(ctx: Ctx, cookieToken: string | undefined): Promise<RefreshResult> {
  if (!cookieToken || cookieToken.length > 128) return { kind: "unauthenticated" };
  const now = ctx.deps.now();
  const db = repo.db(ctx.env.DB);
  const tokenHash = await sha256(cookieToken);

  // 同時に使われて交換に負けた場合は、最新の状態で判定し直す（救済できることがある）
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await repo.findRefreshToken(db, tokenHash);
    if (!found) return { kind: "unauthenticated" };
    const { token, session } = found;
    const successor =
      token.usedAt !== null && token.replacedBy ? await repo.findRefreshTokenById(db, token.replacedBy) : null;

    const decision = decideRefresh(token, session, successor, now);
    if (decision.kind === "reject") return { kind: "unauthenticated" };
    if (decision.kind === "reuse") {
      await repo.revokeSession(db, session.id, now);
      console.warn(JSON.stringify({ event: "refresh_token_reuse", sessionId: session.id }));
      return { kind: "unauthenticated" };
    }

    // rotate：このトークンを交換する。rescue：前回の応答が届かなかったとみなし、次のトークンを交換する
    const usedTokenId = decision.kind === "rescue" && successor ? successor.id : token.id;
    const refreshToken = randomToken();
    const refreshExpiresAt = nextTokenExpiry(now, session.expiresAt);
    const rotated = await repo.tryRotate(db, {
      usedTokenId,
      sessionId: session.id,
      tokenHash: await sha256(refreshToken),
      expiresAt: refreshExpiresAt,
      now,
      // 交換に負けたやり直し（attempt > 0）での救済は、同時に使われたことを確認済みなので印を付けない。
      // 付けると、交換に勝った側の応答のトークンが「提示されたら再利用」になってしまう
      rescue: decision.kind === "rescue" && attempt === 0,
    });
    if (rotated) {
      const access = await issueAccessToken(ctx.env, { userId: session.userId, sessionId: session.id }, now);
      return { kind: "ok", session: { refreshToken, refreshExpiresAt, ...access } };
    }
  }
  return { kind: "unauthenticated" };
}

/** Cookieのトークンが属するセッションを失効させる。トークンがない・無効でも何もしない */
export async function logout(ctx: Ctx, cookieToken: string | undefined) {
  if (!cookieToken || cookieToken.length > 128) return;
  const db = repo.db(ctx.env.DB);
  const found = await repo.findRefreshToken(db, await sha256(cookieToken));
  if (found) await repo.revokeSession(db, found.session.id, ctx.deps.now());
}

export async function logoutAll(ctx: Ctx, viewer: Viewer) {
  await repo.revokeAllSessions(repo.db(ctx.env.DB), viewer.userId, ctx.deps.now());
}

export async function getMe(ctx: Ctx, viewerId: string) {
  return repo.findMe(repo.db(ctx.env.DB), viewerId);
}

export async function isSessionActive(ctx: Ctx, viewer: Viewer) {
  return repo.isSessionActive(repo.db(ctx.env.DB), viewer, ctx.deps.now());
}

export async function updateDisplayName(ctx: Ctx, viewerId: string, displayName: string) {
  const db = repo.db(ctx.env.DB);
  await repo.updateDisplayName(db, viewerId, displayName, ctx.deps.now());
  return repo.findMe(db, viewerId);
}

/** 他のコンテキスト向け：公開プロフィール（ID・表示名・アイコン） */
export async function getPublicProfiles(env: Bindings, userIds: string[]) {
  return repo.findPublicProfiles(repo.db(env.DB), userIds);
}
