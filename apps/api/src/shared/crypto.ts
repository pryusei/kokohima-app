// 乱数・ハッシュ・定数時間比較（WebCrypto）。暗号処理は自作せず、この薄いラッパーだけを使う

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32バイトのランダム値をbase64urlで返す */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** SHA-256 をbase64urlで返す（高エントロピーのトークンの保存用） */
export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toBase64Url(new Uint8Array(digest));
}

/** PKCE の code_challenge（S256） */
export function pkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier);
}

/** 定数時間比較。長さが違えば false */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.byteLength !== eb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ea, eb);
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** 鍵ID → 32バイトの鍵（base64）の JSON。読めない・長さが違う鍵は使わない */
function parseKeys(json: string): Map<string, Uint8Array<ArrayBuffer>> {
  const keys = new Map<string, Uint8Array<ArrayBuffer>>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return keys;
  }
  if (!parsed || typeof parsed !== "object") return keys;
  for (const [kid, value] of Object.entries(parsed)) {
    if (typeof value !== "string") continue;
    try {
      const raw = fromBase64Url(value);
      if (raw.byteLength === 32) keys.set(kid, raw);
    } catch {
      // 壊れた鍵は無視する
    }
  }
  return keys;
}

/** 復号できない（知らない鍵ID・改ざん・AAD の不一致）。中身や鍵はメッセージに入れない */
export class SecretDecryptError extends Error {
  constructor(readonly reason: "unknown_kid" | "malformed" | "invalid") {
    super(reason);
  }
}

const importAesKey = (raw: Uint8Array<ArrayBuffer>) =>
  crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

/**
 * AES-256-GCM で暗号化し、`v1.<kid>.<iv>.<暗号文>` を返す（docs/specs/T-06-calendar.md「トークンの暗号化」）。
 * aad には持ち主を表す値を入れ、別の行に写した暗号文を復号できないようにする
 */
export async function encryptSecret(plain: string, keysJson: string, kid: string, aad: string): Promise<string> {
  const raw = parseKeys(keysJson).get(kid);
  if (!raw) throw new SecretDecryptError("unknown_kid");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) },
    await importAesKey(raw),
    new TextEncoder().encode(plain),
  );
  return `v1.${kid}.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

export async function decryptSecret(stored: string, keysJson: string, aad: string): Promise<string> {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new SecretDecryptError("malformed");
  const [, kid, ivText, cipherText] = parts as [string, string, string, string];
  const raw = parseKeys(keysJson).get(kid);
  if (!raw) throw new SecretDecryptError("unknown_kid");
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(ivText), additionalData: new TextEncoder().encode(aad) },
      await importAesKey(raw),
      fromBase64Url(cipherText),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new SecretDecryptError("invalid");
  }
}

/** 暗号文の鍵ID（ログに出してよい値） */
export function secretKid(stored: string): string | null {
  const parts = stored.split(".");
  return parts.length === 4 && parts[0] === "v1" ? (parts[1] ?? null) : null;
}
