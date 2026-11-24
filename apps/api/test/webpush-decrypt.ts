// テスト用：ブラウザの側の Webプッシュの鍵と復号（RFC 8291 の手順を逆にたどる。本番のコードからは読み込まない）

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const enc = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, n * 8));
}

export type BrowserKeys = { privateKey: CryptoKey; p256dh: Uint8Array; auth: Uint8Array };

/** 秘密の値と公開鍵（非圧縮の点）から、受け手の秘密鍵を読み込む */
export async function importBrowserPrivate(d: Uint8Array, p256dh: Uint8Array) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: b64url(d), x: b64url(p256dh.slice(1, 33)), y: b64url(p256dh.slice(33)) },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

/** ブラウザの購読の鍵（pushManager.subscribe が作るものと同じ形） */
export async function newBrowserKeys(): Promise<BrowserKeys & { json: { p256dh: string; auth: string } }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { privateKey: pair.privateKey, p256dh, auth, json: { p256dh: b64url(p256dh), auth: b64url(auth) } };
}

/** 本文（aes128gcm）を復号して文字列で返す。区切りの 0x02 がなければ投げる */
export async function decryptWebPush(body: Uint8Array, keys: BrowserKeys): Promise<string> {
  const salt = body.slice(0, 16);
  const idlen = body[20] ?? 0;
  const asPublic = body.slice(21, 21 + idlen);
  const pub = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: pub } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      keys.privateKey,
      256,
    ),
  );
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...keys.p256dh, ...asPublic]);
  const ikm = await hkdf(keys.auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 0x02) throw new Error("no_delimiter");
  return new TextDecoder().decode(record.slice(0, end));
}
