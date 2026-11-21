// 画像の種類と大きさの判定（docs/specs/T-08-link-preview.md「画像」）。
// 応答の Content-Type と先頭のバイトの両方が一致し、幅と高さがヘッダーから読めて上限以下のものだけを受け付ける

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_MAX_SIDE = 4096;

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";
export const IMAGE_TYPES: readonly ImageType[] = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const ascii = (b: Uint8Array, at: number, len: number) => String.fromCharCode(...b.subarray(at, at + len));
const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => (((b[at] ?? 0) << 24) >>> 0) + (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));

/** 先頭のバイトから種類を判定する */
export function sniffType(b: Uint8Array): ImageType | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";
  return null;
}

/** JPEG の SOF（C4・C8・CC を除く C0〜CF）から幅と高さ */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i++;
      continue;
    }
    // 長さを持たないマーカー
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) {
    // キーフレームの開始コード 9D 01 2A のあとに幅と高さ（下位14ビット）
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L" && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    const [b0, b1, b2, b3] = [b[21] ?? 0, b[22] ?? 0, b[23] ?? 0, b[24] ?? 0];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === "VP8X" && b.length >= 30) return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  return null;
}

/** 幅と高さ。読めなければ null */
export function imageSize(type: ImageType, b: Uint8Array): { width: number; height: number } | null {
  switch (type) {
    case "image/png":
      return b.length >= 24 && ascii(b, 12, 4) === "IHDR" ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
    case "image/gif":
      return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
    case "image/jpeg":
      return jpegSize(b);
    case "image/webp":
      return webpSize(b);
  }
}

/** 受け付ける画像なら種類。Content-Type と先頭のバイトが合わない・大きさが読めない・上限を超えるなら null */
export function acceptImage(contentType: string, bytes: Uint8Array): ImageType | null {
  const declared = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  const sniffed = sniffType(bytes);
  if (!sniffed || sniffed !== declared) return null;
  const size = imageSize(sniffed, bytes);
  if (!size || size.width < 1 || size.height < 1) return null;
  if (size.width > IMAGE_MAX_SIDE || size.height > IMAGE_MAX_SIDE) return null;
  return sniffed;
}
