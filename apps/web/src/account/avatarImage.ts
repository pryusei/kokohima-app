// アイコンの画像を端末の中で作り直す（docs/specs/T-27-avatar-upload.md「端末での作り直し」）。
// 中央を正方形に切り抜き、256×256 の JPEG（品質 0.85）にする。描き直すので、位置情報などのメタデータは残らない

export const AVATAR_SIZE_PX = 256;
export const AVATAR_QUALITY = 0.85;
/** 読むときの幅（縦長の写真でも短い辺が 256 を下回らないように、256 の4倍） */
export const DECODE_WIDTH_PX = 1024;
/** これより大きいファイルは読まない */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

export class AvatarImageError extends Error {}

/** 短い辺に合わせた、中央の正方形の範囲 */
export function centerSquare(width: number, height: number) {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}

export async function makeAvatarJpeg(file: Blob): Promise<Blob> {
  if (file.size === 0 || file.size > MAX_SOURCE_BYTES) throw new AvatarImageError("too_large");
  let bitmap: ImageBitmap;
  try {
    // 画像の向き（Exif の Orientation）は画像のとおりに直して読む。大きな写真を元の解像度で展開しないよう、
    // 幅を DECODE_WIDTH_PX に縮めて読む（高さは比のとおり。切り抜いてから 256×256 にするので、これで足りる）
    bitmap = await createImageBitmap(file, {
      imageOrientation: "from-image",
      resizeWidth: DECODE_WIDTH_PX,
      resizeQuality: "high",
    });
  } catch {
    throw new AvatarImageError("unreadable");
  }
  try {
    const { sx, sy, side } = centerSquare(bitmap.width, bitmap.height);
    if (side === 0) throw new AvatarImageError("unreadable");
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE_PX;
    canvas.height = AVATAR_SIZE_PX;
    const context = canvas.getContext("2d");
    if (!context) throw new AvatarImageError("unreadable");
    // 透明な部分は白にする（JPEG は透明を持てない）
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX);
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", AVATAR_QUALITY));
    if (!blob || blob.type !== "image/jpeg") throw new AvatarImageError("unreadable");
    return blob;
  } finally {
    bitmap.close();
  }
}
