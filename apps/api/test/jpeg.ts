// アイコンの画像のテスト用の JPEG（docs/specs/T-27-avatar-upload.md）。デコードはできないが、マーカーの並びは正しい最小のバイト列

const seg = (marker: number, payload: number[]) => {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
};

export type JpegOptions = {
  width?: number;
  height?: number;
  /** SOF の種類（0xc0 ベースライン、0xc2 プログレッシブ） */
  sof?: number;
  /** Exif（位置情報を含む想定）の APP1 を入れる */
  exif?: boolean;
  /** コメントを入れる */
  comment?: string;
  /** APP13（Photoshop の情報など）を入れる */
  app13?: boolean;
  /** APP0 の中身（既定は JFIF・サムネイルなし）。"jfxx" は JFXX の拡張、"thumb" は 2×1 のサムネイルつきの JFIF */
  app0?: "jfif" | "jfxx" | "thumb";
  /** EOI のあとに付けるバイト */
  trailing?: number[];
  /** 符号化されたデータの大きさ（大きな入力のテスト） */
  scanBytes?: number;
};

/** 埋めておく位置情報の目印（除去されたかを確かめる） */
export const GPS_MARKER = "GPS-35.6812N-139.7671E";
/** 埋め込みのサムネイルの目印 */
export const THUMB_MARKER = "THUMBx";

export function jpeg(o: JpegOptions = {}): Uint8Array {
  const w = o.width ?? 256;
  const h = o.height ?? 256;
  const bytes: number[] = [0xff, 0xd8];
  bytes.push(...seg(0xe0, [...new TextEncoder().encode("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]));
  if (o.app0 === "jfxx") bytes.push(...seg(0xe0, [...new TextEncoder().encode(`JFXX\0\x13${THUMB_MARKER}`)]));
  if (o.app0 === "thumb") {
    // 先頭の APP0 をサムネイルつきの JFIF にする
    bytes.splice(2, 18, ...seg(0xe0, [...new TextEncoder().encode("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 2, 1, ...new TextEncoder().encode(THUMB_MARKER.slice(0, 6))]));
  }
  if (o.exif) bytes.push(...seg(0xe1, [...new TextEncoder().encode(`Exif\0\0${GPS_MARKER}`)]));
  if (o.app13) bytes.push(...seg(0xed, [...new TextEncoder().encode("Photoshop 3.0\0")]));
  if (o.comment) bytes.push(...seg(0xfe, [...new TextEncoder().encode(o.comment)]));
  bytes.push(...seg(0xdb, [0, ...Array<number>(64).fill(1)]));
  bytes.push(...seg(o.sof ?? 0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 0, 3, 0x11, 0]));
  bytes.push(...seg(0xc4, [0, ...Array<number>(16).fill(0), 0]));
  bytes.push(...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]));
  // 符号化されたデータ：埋め込みの 0xFF00 と RST を含む
  bytes.push(0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78);
  const extra = o.scanBytes ?? 0;
  const tail = [0xff, 0xd9, ...(o.trailing ?? [])];
  const out = new Uint8Array(bytes.length + extra + tail.length);
  out.set(bytes);
  for (let i = 0; i < extra; i++) out[bytes.length + i] = i % 251;
  out.set(tail, bytes.length + extra);
  return out;
}

export const includesText = (bytes: Uint8Array, text: string) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s.includes(text);
};
