import { useEffect } from "react";

// プライバシー ポリシーと利用規約の共通の値（docs/specs/T-19-privacy-terms.md「2.」「5.」）

/**
 * 制定日の行。「制定日：」と日付を分けずに1つの文字列で持つ（ビルドした JS で並びを検査するため。check-web-dist.mjs）。
 * 仮の値のままでは deploy:prod が止まる。決めたら「制定日：YYYY年M月D日」にする
 */
export const EFFECTIVE_DATE_LINE = "制定日：2026年11月23日";

// 改定の日付（docs/specs/T-19-privacy-terms.md「8.」）。本格稼働（一般公開）までは予告なしで、改定日＝マージしてデプロイする日にする（T-19 決めたこと17）。
// 一般公開のあとは、公表日＝本番にデプロイする日、改定日（効力が生じる日）＝その7日後。
// デプロイの日がずれたら、デプロイの前に、この2つの文字列の日付を同じだけずらす。問い合わせを始める日（T-24）より前なら、
// packages/shared/src/contactStart.json の startDate も改定日と同じ日にずらす（ほかの場所に日付を書かない）。
// ブロックと通報を始める日（packages/shared/src/safetyStart.json。T-33）も、改定日と同じ日にずらす。
// 前の改定（公表日 2026-11-23・改定日 2026-11-30）では、利用者の判断で問い合わせを公表日から開いた（docs/specs/T-24-contact.md 決めたこと10）。
// deploy:prod（check-web-dist.mjs --deploy）は、公表日が日本時間の今日より後、予告が7日より短いか30日より長い、
// 改定日を過ぎても公表日の行が残っている、のどれでも止まる

/**
 * 改定日の行。「改定日（効力が生じる日）：YYYY年M月D日」の1つの文字列（行は1つだけ。2回めからは日付を書き換える）。
 * 改定していなければ null。入れたら、制定日と同じく deploy:prod で本物の日付かを検査する
 */
export const REVISION_DATE_LINE: string | null = "改定日（効力が生じる日）：2026年11月24日";

/**
 * 予告の行。予告の間（公表日から改定日まで）だけ入れ、ほかのときは null（決めたこと14）。
 * 改定日を過ぎたら、PRIVACY_REVISION_CHANGES・TERMS_REVISION_CHANGES とともに null に戻す（「8.」の5）
 */
export const REVISION_NOTICE_LINE: string | null = null;

/**
 * 「この改定で変わるところ」の箇条書き（決めたこと15）。予告の行があるときだけ出す。
 * 文に「制定日：」「改定日（効力が生じる日）：」「公表日：」を入れない（ビルドの検査の数がずれるため）。
 * 今は予告なしの改定なので null（T-19 決めたこと17）
 */
export const PRIVACY_REVISION_CHANGES: readonly string[] | null = null;
export const TERMS_REVISION_CHANGES: readonly string[] | null = null;

export const CONTACT_EMAIL = "ops@kokohima.app";

const APP_TITLE = "ここ暇";

/** 開いている間だけ、タブの題を「<題>｜ここ暇」にする。離れたら「ここ暇」に戻す */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title}｜${APP_TITLE}`;
    return () => {
      document.title = APP_TITLE;
    };
  }, [title]);
}
