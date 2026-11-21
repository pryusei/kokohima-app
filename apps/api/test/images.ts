// リンクのプレビューのテスト用の画像のヘッダー（幅と高さだけを持つ最小のバイト列）

/** テスト用の画像のヘッダー */
export const images = {
  png(width: number, height: number) {
    const b = new Uint8Array(33);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(b.buffer).setUint32(16, width);
    new DataView(b.buffer).setUint32(20, height);
    return b;
  },
  gif(width: number, height: number) {
    const b = new Uint8Array(13);
    b.set([...new TextEncoder().encode("GIF89a")]);
    new DataView(b.buffer).setUint16(6, width, true);
    new DataView(b.buffer).setUint16(8, height, true);
    return b;
  },
  jpeg(width: number, height: number) {
    // SOI、APP0（長さ16）、SOF0
    const b = new Uint8Array(2 + 18 + 19);
    b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const sof = 20;
    b.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof);
    new DataView(b.buffer).setUint16(sof + 5, height);
    new DataView(b.buffer).setUint16(sof + 7, width);
    return b;
  },
  webpX(width: number, height: number) {
    const b = new Uint8Array(30);
    b.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8X"));
    const dv = new DataView(b.buffer);
    const w = width - 1;
    const h = height - 1;
    dv.setUint8(24, w & 0xff);
    dv.setUint8(25, (w >> 8) & 0xff);
    dv.setUint8(26, (w >> 16) & 0xff);
    dv.setUint8(27, h & 0xff);
    dv.setUint8(28, (h >> 8) & 0xff);
    dv.setUint8(29, (h >> 16) & 0xff);
    return b;
  },
  webpL(width: number, height: number) {
    const b = new Uint8Array(30);
    b.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8L"));
    const w = width - 1;
    const h = height - 1;
    const bits = w | (h << 14);
    b.set([0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >> 24) & 0xff], 20);
    return b;
  },
  webpLossy(width: number, height: number) {
    const b = new Uint8Array(30);
    b.set(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "));
    b.set([0x9d, 0x01, 0x2a], 23);
    new DataView(b.buffer).setUint16(26, width, true);
    new DataView(b.buffer).setUint16(28, height, true);
    return b;
  },
};
