import { importPKCS8, SignJWT } from "jose";
import type { AppDeps, Bindings } from "../../env";
import { pushEndpointOrigin } from "../domain/endpoint";

// Webプッシュの送信（RFC 8030・RFC 8292）。本文は RFC 8291 で暗号化したもの（T-35。webpush-encryption.ts）か、
// 鍵のない購読（T-35 より前に登録したもの）には本文なし。endpoint・鍵・本文・応答の本文はログに出さない

const TIMEOUT_MS = 5000;
const TTL_SECONDS = 86400;
const JWT_LIFETIME_SECONDS = 12 * 60 * 60;

/** gone：購読を消す。rejected：この購読だけ一時的でない失敗。一時的な失敗は投げる */
/** rejected は一時的でない失敗。status はログに出す状態コード（宛先の検証で断ったときは0） */
export type PushResult = { outcome: "sent" | "gone" | "rejected"; status: number };

export class PushUnavailable extends Error {
  constructor(readonly status: number) {
    super("push_unavailable");
  }
}

/** body は暗号化した本文（aes128gcm）。null なら本文なしで送る */
export async function sendPush(env: Bindings, deps: AppDeps, endpoint: string, body: Uint8Array | null = null): Promise<PushResult> {
  // 保存した値でも、送る直前にもう一度確かめる
  const audience = pushEndpointOrigin(endpoint, deps.notification.extraPushHosts);
  if (!audience) return { outcome: "rejected", status: 0 };
  const key = await importPKCS8(env.VAPID_PRIVATE_KEY, "ES256");
  const now = Math.floor(deps.now() / 1000);
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setAudience(audience)
    .setSubject(env.VAPID_SUBJECT)
    .setExpirationTime(now + JWT_LIFETIME_SECONDS)
    .sign(key);

  let res: Response;
  try {
    res = await deps.fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...(body
          ? { "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream" }
          : { "Content-Length": "0" }),
        TTL: String(TTL_SECONDS),
        Urgency: "normal",
        Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new PushUnavailable(0);
  }
  if (res.status === 201 || res.status === 202 || res.status === 200) return { outcome: "sent", status: res.status };
  if (res.status === 404 || res.status === 410) return { outcome: "gone", status: res.status };
  if (res.status === 429 || res.status >= 500) throw new PushUnavailable(res.status);
  // 3xx（リダイレクトは追わない）・400・401・403・413 など
  return { outcome: "rejected", status: res.status };
}
