import { contactStartAt, isContactOpen } from "@kokohima/shared";

// 問い合わせの公開の日（docs/specs/T-24-contact.md「振る舞い 11.」）。端末の時刻で見る。
// 早く出ても API が404 を返すので受け付けない。E2E の画面（E2E=1 の vite）だけは開いた扱い（本番のビルドでは false）

const START_AT = contactStartAt();

export const isContactOpenNow = (now = Date.now()) => __CONTACT_FORCE_OPEN__ || isContactOpen(now, START_AT);
