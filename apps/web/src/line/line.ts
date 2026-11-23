// LINEで送る・LINEのアプリ内ブラウザの見分け（docs/specs/T-28-line-share.md）
// LINEのAPIは呼ばない。共有は line.me の共有のURLを開くだけ

/** LINEのアプリ内ブラウザで開いたURLを、外のブラウザで開き直させるLINEの決まりのクエリ */
export const OPEN_EXTERNAL_BROWSER = "openExternalBrowser";

/** URL の `#` の前に `?openExternalBrowser=1` を足す。フラグメント（招待リンクのトークン）はそのまま */
export function withOpenExternalBrowser(url: string): string {
  const u = new URL(url, window.location.origin);
  u.searchParams.set(OPEN_EXTERNAL_BROWSER, "1");
  // 相対のURL（`/invite#t=…`）は相対のまま返す
  return /^https?:\/\//i.test(url) ? u.toString() : `${u.pathname}${u.search}${u.hash}`;
}

/** 「LINEで送る」の行き先。本文は固定の文と招待リンクだけ（名前・ひとことは入れない） */
export function lineShareHref(inviteUrl: string): string {
  const text = `ここ暇で友達になろう\n${withOpenExternalBrowser(inviteUrl)}`;
  return `https://line.me/R/share?text=${encodeURIComponent(text)}`;
}

/**
 * LINEのアプリ内ブラウザか。UA に「 Line/」（前に空白、大文字小文字を区別）があるか。
 * T-25 の「UA で判定しない」の例外（T-28 決めたこと3）。外れても帯が出ない・余計に出るだけ
 */
export function isLineInAppBrowser(userAgent: string = navigator.userAgent): boolean {
  return / Line\//.test(userAgent);
}
