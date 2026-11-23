// アイコンの画像の検証とメタデータの除去（docs/specs/T-27-avatar-upload.md「サーバーでの検証とメタデータの除去」）。
// デコードはしない。マーカーを左から1回だけ読み、残すセグメントだけを写す（かかる時間は大きさに比例する）

export const AVATAR_SIZE_PX = 256;
export const AVATAR_MAX_BYTES = 200 * 1024;

export type AvatarJpegError = "invalid_image" | "invalid_size";
export type AvatarJpegResult = { ok: true; bytes: Uint8Array } | { ok: false; error: AvatarJpegError };

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const APP0 = 0xe0;
const COM = 0xfe;
/** 長さつきで残すセグメント：DQT・DHT・DRI と SOF0（ベースライン）・SOF2（プログレッシブ） */
const KEEP = new Set([0xdb, 0xc4, 0xdd, 0xc0, 0xc2]);
const SOF = new Set([0xc0, 0xc2]);
const isApp = (m: number) => m >= APP0 && m <= 0xef;
const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;

const fail = (error: AvatarJpegError): AvatarJpegResult => ({ ok: false, error });

export function sanitizeAvatarJpeg(input: Uint8Array): AvatarJpegResult {
  const n = input.length;
  if (n < 4 || input[0] !== 0xff || input[1] !== SOI) return fail("invalid_image");
  const parts: Uint8Array[] = [input.subarray(0, 2)];
  let pos = 2;
  let sawSof = false;
  let sawApp0 = false;
  let sawSos = false;
  let size: { w: number; h: number } | null = null;

  for (;;) {
    if (pos + 1 >= n || input[pos] !== 0xff) return fail("invalid_image");
    // マーカーの前の埋め草の 0xFF は飛ばす
    while (pos < n && input[pos] === 0xff) pos++;
    if (pos >= n) return fail("invalid_image");
    const marker = input[pos]!;
    const markerStart = pos - 1;
    pos++;

    if (marker === EOI) {
      // EOI のあとにデータがあるものは受け付けない
      if (pos !== n || !sawSos) return fail("invalid_image");
      parts.push(input.subarray(markerStart, pos));
      break;
    }
    if (pos + 2 > n) return fail("invalid_image");
    const length = (input[pos]! << 8) | input[pos + 1]!;
    if (length < 2 || pos + length > n) return fail("invalid_image");
    const segmentEnd = pos + length;

    if (marker === SOS) {
      if (!sawSof) return fail("invalid_image");
      // SOS のあとの符号化されたデータは、次の（RST と埋め込みの 0xFF00 でない）マーカーまで
      let p = segmentEnd;
      for (;;) {
        if (p + 1 >= n) return fail("invalid_image");
        if (input[p] === 0xff) {
          const next = input[p + 1]!;
          if (next === 0x00 || isRst(next) || next === 0xff) {
            p += next === 0xff ? 1 : 2;
            continue;
          }
          break;
        }
        p++;
      }
      parts.push(input.subarray(markerStart, p));
      sawSos = true;
      pos = p;
      continue;
    }

    if (marker === APP0) {
      // JFIF は1つだけ残す（2つめ以降は除く）
      if (!sawApp0) parts.push(input.subarray(markerStart, segmentEnd));
      sawApp0 = true;
    } else if (isApp(marker) || marker === COM) {
      // Exif・XMP・位置情報など（APP1〜APP15）とコメントは除く
    } else if (KEEP.has(marker)) {
      if (SOF.has(marker)) {
        if (sawSof || length < 8) return fail("invalid_image");
        const h = (input[pos + 3]! << 8) | input[pos + 4]!;
        const w = (input[pos + 5]! << 8) | input[pos + 6]!;
        const components = input[pos + 7]!;
        if ((components !== 1 && components !== 3) || length !== 8 + components * 3) return fail("invalid_image");
        sawSof = true;
        size = { w, h };
      }
      parts.push(input.subarray(markerStart, segmentEnd));
    } else {
      // ほかの SOF（算術符号・可逆など）や知らないマーカー
      return fail("invalid_image");
    }
    pos = segmentEnd;
  }

  if (!size || size.w !== AVATAR_SIZE_PX || size.h !== AVATAR_SIZE_PX) return fail("invalid_size");
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return { ok: true, bytes: out };
}
