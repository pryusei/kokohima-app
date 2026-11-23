import { useEffect } from "react";

// プライバシー ポリシーと利用規約の共通の値（docs/specs/T-19-privacy-terms.md「2.」「5.」）

/**
 * 制定日の行。「制定日：」と日付を分けずに1つの文字列で持つ（ビルドした JS で並びを検査するため。check-web-dist.mjs）。
 * 仮の値のままでは deploy:prod が止まる。決めたら「制定日：YYYY年M月D日」にする
 */
export const EFFECTIVE_DATE_LINE = "制定日：2026年11月23日";

/**
 * 改定日の行。初めて改定したときに「改定日：YYYY年M月D日」の1つの文字列にし、次からは日付を書き換える（行は1つだけ）。
 * まだ改定していないので null。入れたら、制定日と同じく deploy:prod で本物の日付かを検査する
 */
export const REVISION_DATE_LINE: string | null = null;

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
