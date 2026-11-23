import { describe, expect, it } from "vitest";
import { GPS_MARKER, includesText, jpeg, THUMB_MARKER } from "../../../test/jpeg";
import { images } from "../../../test/images";
import { sanitizeAvatarJpeg } from "./avatarJpeg";
import { avatarUrlExpiry, isAvatarExpiryAcceptable } from "./avatarUrl";

// docs/specs/T-27-avatar-upload.md「サーバーでの検証とメタデータの除去」「署名」

const ok = (bytes: Uint8Array) => {
  const r = sanitizeAvatarJpeg(bytes);
  if (!r.ok) throw new Error(`expected ok, got ${r.error}`);
  return r.bytes;
};
const errorOf = (bytes: Uint8Array) => {
  const r = sanitizeAvatarJpeg(bytes);
  return r.ok ? "ok" : r.error;
};

describe("sanitizeAvatarJpeg", () => {
  it("256×256 のベースライン・プログレッシブはそのまま通る", () => {
    const base = jpeg();
    expect(ok(base)).toEqual(base);
    const progressive = jpeg({ sof: 0xc2 });
    expect(ok(progressive)).toEqual(progressive);
  });

  it("Exif（位置情報）・APP13・コメントを除き、APP0 と画像のデータは残す", () => {
    const withMeta = jpeg({ exif: true, app13: true, comment: "secret comment" });
    expect(includesText(withMeta, GPS_MARKER)).toBe(true);
    const out = ok(withMeta);
    expect(includesText(out, GPS_MARKER)).toBe(false);
    expect(includesText(out, "Photoshop")).toBe(false);
    expect(includesText(out, "secret comment")).toBe(false);
    expect(includesText(out, "JFIF")).toBe(true);
    // メタデータのない同じ画像と、バイトまで一致する
    expect(out).toEqual(jpeg());
  });

  it("APP0 は JFIF の基本の部分だけを残す：JFXX・サムネイル・2つめの APP0 は除く", () => {
    const jfxx = ok(jpeg({ app0: "jfxx" }));
    expect(includesText(jfxx, "JFXX")).toBe(false);
    expect(includesText(jfxx, THUMB_MARKER)).toBe(false);
    expect(jfxx).toEqual(jpeg());
    const thumb = ok(jpeg({ app0: "thumb" }));
    expect(includesText(thumb, THUMB_MARKER)).toBe(false);
    expect(thumb).toEqual(jpeg());
    // JFIF でない APP0 しかなければ、APP0 なしで通る
    const noJfif = jpeg();
    noJfif.set(new TextEncoder().encode("JFXX"), 6);
    const out = ok(noJfif);
    expect(includesText(out, "JFXX")).toBe(false);
    expect(out.length).toBe(jpeg().length - 18);
  });

  it("256 以外の縦横は invalid_size", () => {
    expect(errorOf(jpeg({ width: 255 }))).toBe("invalid_size");
    expect(errorOf(jpeg({ height: 512 }))).toBe("invalid_size");
    expect(errorOf(jpeg({ width: 4096, height: 4096 }))).toBe("invalid_size");
  });

  it("JPEG と偽った PNG・WebP・SVG、ほかの SOF、知らないマーカーは invalid_image", () => {
    expect(errorOf(images.png(256, 256))).toBe("invalid_image");
    expect(errorOf(images.webpX(256, 256))).toBe("invalid_image");
    expect(errorOf(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("invalid_image");
    expect(errorOf(jpeg({ sof: 0xc1 }))).toBe("invalid_image");
    expect(errorOf(jpeg({ sof: 0xc9 }))).toBe("invalid_image");
    const unknown = jpeg();
    unknown[2 + 1] = 0xf7; // APP0 の位置を JPEG-LS のマーカーに
    expect(errorOf(unknown)).toBe("invalid_image");
  });

  it("長さのはみ出し・途中で切れたもの・EOI なし・EOI のあとのデータは invalid_image", () => {
    const base = jpeg();
    const overflow = base.slice();
    overflow[4] = 0xff; // APP0 の長さを大きく
    expect(errorOf(overflow)).toBe("invalid_image");
    expect(errorOf(base.subarray(0, base.length - 2))).toBe("invalid_image");
    expect(errorOf(base.subarray(0, 30))).toBe("invalid_image");
    expect(errorOf(jpeg({ trailing: [0x00] }))).toBe("invalid_image");
    expect(errorOf(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toBe("invalid_image");
    expect(errorOf(new Uint8Array(0))).toBe("invalid_image");
  });

  it("大きな入力でも1回の走査で終わる", () => {
    const big = jpeg({ scanBytes: 200 * 1024 });
    const started = performance.now();
    expect(errorOf(big)).toBe("ok");
    // 0xFF が並ぶ入力（埋め草）でも同じ
    const fill = new Uint8Array(200 * 1024).fill(0xff);
    fill[1] = 0xd8;
    expect(errorOf(fill)).toBe("invalid_image");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("署名つき URL の期限", () => {
  const at = (iso: string) => Date.parse(iso);

  it("1時間単位で切り上げて＋1時間。同じ1時間の中では同じ値", () => {
    const e = avatarUrlExpiry(at("2026-10-10T00:10:00Z"));
    expect(e).toBe(at("2026-10-10T02:00:00Z") / 1000);
    expect(avatarUrlExpiry(at("2026-10-10T00:59:58Z"))).toBe(e);
    expect(avatarUrlExpiry(at("2026-10-10T01:00:00Z"))).toBe(at("2026-10-10T03:00:00Z") / 1000);
  });

  it("出した期限は受け付け、期限切れ・遠すぎる期限は受け付けない", () => {
    const now = at("2026-10-10T00:10:00Z");
    const e = avatarUrlExpiry(now);
    expect(isAvatarExpiryAcceptable(e, now)).toBe(true);
    expect(isAvatarExpiryAcceptable(e, e * 1000)).toBe(false);
    expect(isAvatarExpiryAcceptable(e, e * 1000 - 1000)).toBe(true);
    expect(isAvatarExpiryAcceptable(now / 1000 + 2 * 3600 + 61, now)).toBe(false);
    expect(isAvatarExpiryAcceptable(Number.MAX_SAFE_INTEGER + 1, now)).toBe(false);
  });
});
