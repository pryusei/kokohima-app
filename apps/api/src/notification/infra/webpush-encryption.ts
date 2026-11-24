// Webプッシュのペイロードの暗号化（RFC 8291・RFC 8188 の aes128gcm。docs/specs/T-35-notification-visibility.md「暗号化」）
// WebCrypto の ECDH（P-256）・HKDF（SHA-256）・AES-128-GCM を組み合わせるだけで、暗号の部品は自作しない。
// 鍵・本文はログに出さない

const enc = new TextEncoder();

/** 1つのレコードの大きさ（RFC 8188 の rs）。本文は必ず1レコードに収める */
export const RECORD_SIZE = 4096;
const TAG_LENGTH = 16;
const HEADER_LENGTH = 16 + 4 + 1 + 65;

/**
 * 暗号化する前の長さ（本文＋区切りの 0x02＋詰め物）。本文の長さにかかわらずこの長さにそろえ、
 * プッシュのサービスに、暗号文の長さから種類や名前の長さを推し量らせない
 */
export const PADDED_LENGTH = 1024;
/** 暗号化したプッシュの本文の長さ（ヘッダー＋暗号文＋認証タグ）。いつも同じ */
export const ENCRYPTED_LENGTH = HEADER_LENGTH + PADDED_LENGTH + TAG_LENGTH;

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

const b64url = (bytes: Uint8Array) => {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** 非圧縮の点（65バイト）と秘密の値（32バイト）から、ECDH の秘密鍵を読み込む（テストで RFC の例の鍵を使うため） */
async function importPrivate(privateKey: Uint8Array, publicKey: Uint8Array) {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: b64url(privateKey),
      x: b64url(publicKey.slice(1, 33)),
      y: b64url(publicKey.slice(33, 65)),
      ext: true,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export class PayloadTooLarge extends Error {
  constructor() {
    super("payload_too_large");
  }
}

export type WebPushKeys = {
  /** 受け手（ブラウザ）の公開鍵。非圧縮の P-256 の点（65バイト） */
  p256dh: Uint8Array;
  /** 受け手の認証の秘密（16バイト） */
  auth: Uint8Array;
};

/** テストだけで渡す：送り手の一時的な鍵と salt を固定する（RFC 8291 の付録の例と突き合わせるため） */
export type Fixed = { salt: Uint8Array; serverPrivateKey: Uint8Array; serverPublicKey: Uint8Array; paddedLength?: number };

/**
 * RFC 8291 で本文を暗号化し、プッシュの本文（`Content-Encoding: aes128gcm`）を返す。
 * 送るたびに一時的な鍵の組と salt を作る。本文は PADDED_LENGTH にそろえる（入らなければ PayloadTooLarge）
 */
export async function encryptWebPush(plaintext: Uint8Array, keys: WebPushKeys, fixed?: Fixed): Promise<Uint8Array> {
  if (keys.p256dh.byteLength !== 65 || keys.p256dh[0] !== 0x04 || keys.auth.byteLength !== 16) {
    throw new Error("invalid_subscription_keys");
  }
  const paddedLength = fixed?.paddedLength ?? PADDED_LENGTH;
  if (plaintext.byteLength + 1 > paddedLength) throw new PayloadTooLarge();

  let serverPrivate: CryptoKey;
  let serverPublic: Uint8Array;
  if (fixed) {
    serverPrivate = await importPrivate(fixed.serverPrivateKey, fixed.serverPublicKey);
    serverPublic = fixed.serverPublicKey;
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair;
    serverPrivate = pair.privateKey;
    serverPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  }
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const uaPublic = await crypto.subtle.importKey("raw", keys.p256dh, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm, serverPrivate, 256),
  );

  // RFC 8291 3.4：IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(enc.encode("WebPush: info\0"), keys.p256dh, serverPublic);
  const ikm = await hkdf(keys.auth, ecdhSecret, keyInfo, 32);
  // RFC 8188 2.2・2.3：CEK と NONCE
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  // 最後のレコード：本文 || 0x02 || 0x00 の詰め物
  const record = new Uint8Array(paddedLength);
  record.set(plaintext, 0);
  record[plaintext.byteLength] = 0x02;
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  // ヘッダー：salt(16) || rs(4、ビッグエンディアン) || idlen(1) || keyid（送り手の公開鍵 65バイト）
  const header = new Uint8Array(HEADER_LENGTH);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(serverPublic, 21);
  return concat(header, ciphertext);
}
