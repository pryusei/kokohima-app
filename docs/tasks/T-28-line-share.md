# T-28 LINEで送る（招待リンクをLINEで送る・LINEのブラウザで開いた人を外のブラウザへ案内する）

## 目的
友達とのやりとりはLINEが入口になっている（要求定義書「既存の手段」「友達が使わない」）。招待リンクをLINEのトークにそのまま送れるようにし、LINEで開いた友達が、Googleのログインを断られるLINEのアプリ内ブラウザで止まらず、Safari・Chromeで開けるようにする。友達を増やす入口の詰まりを取る。

LINEの公式アカウントからお知らせを受け取る機能（T-28b）は、需要が見えてから別のタスクにする（スコープ外）。

## 関係する要件
- F-08：友達追加（招待リンクを都度発行し、LINEなどで送る）
- F-01：認証（Googleのログインは、LINEのアプリ内ブラウザでは断られる）
- 要求定義書「リスクと対策」：友達が使わない（LINEに貼れる招待リンク）
- docs/specs/T-25-installable-pwa.md「それ以外」の画面（UA の判定をしない、の例外を作る）

## スコープ
- やること：
  - 実装の前に、iPhone・Android の実機で `openExternalBrowser=1` の動きを確かめる（仕様書の「実装の前に確かめること」）
  - 招待リンクを作ったシートに「LINEで送る」を足す（`line.me` の共有のURLを開くだけ。LINEのAPIは呼ばない）
  - LINEで送るURLに `openExternalBrowser=1` を付ける
  - 招待の受け口とログインの画面で、LINEのアプリ内ブラウザで開いているときだけ、外のブラウザで開き直す案内の帯を出す
- やらないこと（スコープ外）：
  - LINEの公式アカウントからお知らせを受け取ること（T-28b。需要が見えてから）
  - LINEでのログイン、LINEのAPI、LIFF
  - 誘い・募集・予定のURLをLINEで送るボタン
  - LINE以外のアプリ内ブラウザ（Instagram など）の判定

## 受け入れ条件
- [ ] 実機の確認の結果（iPhone・Android、開き直したときにトークンが残るか）を実装PRに書いた（iPhone は確かめた。Android はマージのあとに回した。仕様書の「実機の確認の結果」）
- [ ] 招待リンクを作ったシートに「LINEで送る」があり、押すとLINEの送り先を選ぶ画面が開き、本文に招待リンクが入っている
- [ ] LINEのトークで招待リンクを開くと、外のブラウザで開き、発行者の名前が出る（実機で確かめる）
- [ ] LINEのアプリ内ブラウザで招待の受け口・ログインの画面を開くと、案内の帯と「ブラウザで開き直す」が出る。LINE以外のブラウザでは出ない
- [ ] 案内の帯は赤やエラー色を使わない
- [ ] 招待リンクのトークンを localStorage・sessionStorage に置かない
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-28-line-share.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 画面：招待リンクの発行のシート（`apps/web/src/account/InviteLinkSheet.tsx` の `InviteLinkSheet`。T-34 で `FriendsPage.tsx` から移した）、招待の受け口（`apps/web/src/pages/InvitePage.tsx`）、ログイン（`apps/web/src/pages/LoginPage.tsx`）
- 関係するスキル：e2e-testing、vercel-react-best-practices
- 似た仕組み：docs/specs/T-02-friends.md（招待リンクのURL・受け口）、docs/specs/T-25-installable-pwa.md（アプリ内ブラウザ向けの一文）
