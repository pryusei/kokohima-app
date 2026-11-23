// アイコンの画像の署名つき URL（docs/specs/T-27-avatar-upload.md「署名」）。署名の計算そのものは application（Web Crypto）で行う

const HOUR_S = 60 * 60;
/** 期限の上限（今から2時間）に足す、時計のずれの猶予 */
const CLOCK_SKEW_S = 60;

/** 期限（Unix 秒）：今を1時間単位で切り上げた時刻＋1時間。同じ1時間の中では同じ値になる */
export function avatarUrlExpiry(nowMs: number): number {
  const nowS = Math.floor(nowMs / 1000);
  return Math.ceil((nowS + 1) / HOUR_S) * HOUR_S + HOUR_S;
}

/** 受け取った期限が、今より後で、出しうる最も遠い期限（今＋2時間＋猶予）より前か */
export function isAvatarExpiryAcceptable(expiry: number, nowMs: number): boolean {
  const nowS = Math.floor(nowMs / 1000);
  return Number.isSafeInteger(expiry) && expiry > nowS && expiry <= nowS + 2 * HOUR_S + CLOCK_SKEW_S;
}

/** 署名する文字列 */
export const avatarSigningInput = (avatarId: string, expiry: number) => `avatar:v1:${avatarId}:${expiry}`;

/** 相対パス（API は APP_ORIGIN と同じオリジン） */
export const avatarPath = (avatarId: string, expiry: number, signature: string) =>
  `/api/v1/avatars/${avatarId}?e=${expiry}&s=${signature}`;
