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
