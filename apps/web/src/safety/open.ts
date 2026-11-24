import { isSafetyOpen, safetyStartAt } from "@kokohima/shared";

// ブロックと通報を始める日（docs/specs/T-33-block-report.md「振る舞い 8.」）。端末の時刻で見る。
// 早く出ても API が404 を返すので受け付けない。E2E の画面（E2E=1 の vite）だけは開いた扱い（本番のビルドでは false）

const START_AT = safetyStartAt();

export const isSafetyOpenNow = (now = Date.now()) => __SAFETY_FORCE_OPEN__ || isSafetyOpen(now, START_AT);
