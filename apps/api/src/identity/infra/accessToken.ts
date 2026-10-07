import { jwtVerify, SignJWT } from "jose";
import type { Bindings, Viewer } from "../../env";

// アクセストークン（HS256のJWT、10分）。鍵は JWT_SIGNING_KEYS（{"<kid>": "<base64url>"}）から kid で選ぶ

export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
const ISSUER = "kokohima";
const AUDIENCE = "kokohima-api";

function decodeBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function signingKeys(env: Pick<Bindings, "JWT_SIGNING_KEYS">): Map<string, Uint8Array> {
  const parsed: unknown = JSON.parse(env.JWT_SIGNING_KEYS);
  const keys = new Map<string, Uint8Array>();
  if (parsed && typeof parsed === "object") {
    for (const [kid, value] of Object.entries(parsed)) {
      if (typeof value !== "string") continue;
      const key = decodeBase64Url(value);
      if (key.byteLength >= 32) keys.set(kid, key);
    }
  }
  return keys;
}

export async function issueAccessToken(
  env: Pick<Bindings, "JWT_SIGNING_KEYS" | "JWT_CURRENT_KID">,
  viewer: Viewer,
  now: number,
): Promise<{ accessToken: string; expiresAt: string }> {
  const key = signingKeys(env).get(env.JWT_CURRENT_KID);
  if (!key) throw new Error("current signing key is not configured");
  const exp = now + ACCESS_TOKEN_TTL_MS;
  const accessToken = await new SignJWT({ sid: viewer.sessionId })
    .setProtectedHeader({ alg: "HS256", kid: env.JWT_CURRENT_KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(viewer.userId)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(exp / 1000))
    .sign(key);
  return { accessToken, expiresAt: new Date(exp).toISOString() };
}

/** 検証に失敗したら null（理由は区別しない） */
export async function verifyAccessToken(
  env: Pick<Bindings, "JWT_SIGNING_KEYS">,
  token: string,
  now: number,
): Promise<Viewer | null> {
  const keys = signingKeys(env);
  try {
    const { payload } = await jwtVerify(
      token,
      (header) => {
        const key = header.kid ? keys.get(header.kid) : undefined;
        if (!key) throw new Error("unknown kid");
        return key;
      },
      {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTolerance: 30,
        currentDate: new Date(now),
        requiredClaims: ["sub", "exp", "iat"],
      },
    );
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") return null;
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}
