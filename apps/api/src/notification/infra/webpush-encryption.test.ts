import { describe, expect, it } from "vitest";
import { decryptWebPush, importBrowserPrivate } from "../../../test/webpush-decrypt";
import { ENCRYPTED_LENGTH, encryptWebPush, PADDED_LENGTH, PayloadTooLarge } from "./webpush-encryption";

// RFC 8291 の付録 A（Intermediate Values for Encryption）の例と突き合わせる（docs/specs/T-35-notification-visibility.md「テスト計画」）

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "c9f58f89813e9f8e872e71f42aa64e1757c9254dcc62b72ddc010bb4043ea11c",
  asPublic:
    "04fe33f4ab0dea71914db55823f73b54948f41306d920732dbb9a59a53286482200e597a7b7bc260ba1c227998580992e93973002f3012a28ae8f06bbb78e5ec0f",
  uaPrivate: "ab5757a70dd4a53e553a6bbf71ffefea2874ec07a6b379e3c48f895a02dc33de",
  uaPublic:
    "042571b2becdfde360551aaf1ed0f4cd366c11cebe555f89bcb7b186a53339173168ece2ebe018597bd30479b86e3c8f8eced577ca59187e9246990db682008b0e",
  auth: "05305932a1c7eabe13b6cec9fda48882",
  salt: "0c6bfaadad67958803092d454676f397",
  message:
    "0c6bfaadad67958803092d454676f397000010004104fe33f4ab0dea71914db55823f73b54948f41306d920732dbb9a59a53286482200e597a7b7bc260ba1c227998580992e93973002f3012a28ae8f06bbb78e5ec0ff297de5b429bba7153d3a4ae0caa091fd425f3b4b5414add8ab37a19c1bbb05cf5cb5b2a2e0562d558635641ec52812c6c8ff42e95ccb86be7cd",
};

/** RFC の例の受け手の鍵 */
const rfcBrowser = async () => ({
  privateKey: await importBrowserPrivate(hex(RFC.uaPrivate), hex(RFC.uaPublic)),
  p256dh: hex(RFC.uaPublic),
  auth: hex(RFC.auth),
});

describe("RFC 8291 の暗号化", () => {
  it("付録 A の例と、1バイトも違わない本文を作る", async () => {
    const body = await encryptWebPush(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: hex(RFC.uaPublic), auth: hex(RFC.auth) },
      {
        salt: hex(RFC.salt),
        serverPrivateKey: hex(RFC.asPrivate),
        serverPublicKey: hex(RFC.asPublic),
        paddedLength: RFC.plaintext.length + 1,
      },
    );
    expect(toHex(body)).toBe(RFC.message);
  });

  it("付録 A の例を、受け手の鍵で復号すると元の本文に戻る", async () => {
    expect(await decryptWebPush(hex(RFC.message), await rfcBrowser())).toBe(RFC.plaintext);
  });

  it("送るたびに鍵と salt が変わり、長さはいつも同じ。受け手の鍵で復号できる", async () => {
    const keys = { p256dh: hex(RFC.uaPublic), auth: hex(RFC.auth) };
    const short = await encryptWebPush(new TextEncoder().encode("{}"), keys);
    const long = await encryptWebPush(new TextEncoder().encode("x".repeat(500)), keys);
    const again = await encryptWebPush(new TextEncoder().encode("{}"), keys);
    expect(short.byteLength).toBe(ENCRYPTED_LENGTH);
    expect(long.byteLength).toBe(ENCRYPTED_LENGTH);
    expect(toHex(short.slice(0, 16))).not.toBe(toHex(again.slice(0, 16)));
    expect(toHex(short.slice(21, 86))).not.toBe(toHex(again.slice(21, 86)));
    expect(await decryptWebPush(short, await rfcBrowser())).toBe("{}");
    expect(await decryptWebPush(long, await rfcBrowser())).toBe("x".repeat(500));
  });

  it("入らない本文と、形の違う鍵は断る", async () => {
    const keys = { p256dh: hex(RFC.uaPublic), auth: hex(RFC.auth) };
    await expect(encryptWebPush(new Uint8Array(PADDED_LENGTH), keys)).rejects.toBeInstanceOf(PayloadTooLarge);
    await expect(encryptWebPush(new Uint8Array(1), { ...keys, auth: new Uint8Array(15) })).rejects.toThrow();
    await expect(encryptWebPush(new Uint8Array(1), { ...keys, p256dh: new Uint8Array(65) })).rejects.toThrow();
  });
});
