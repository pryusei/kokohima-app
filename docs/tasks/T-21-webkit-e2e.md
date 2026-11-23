# T-21 iPhone の Safari（WebKit）で E2E を回す

## 目的
iPhone の Safari だけで起きる画面の不具合（日付・時刻の入力欄がシートの右にはみ出す、など）を、マージの前に E2E で見つけられるようにする。今の E2E は Chromium だけで回していて、iPhone での後戻りに気づけない。

## 関係する要件
- 要求定義書「形態」：PWA（Web）先行。利用者の多くは iPhone の Safari で開く
- T-11（シート・入力欄）。docs/specs/T-11-design.md。T-11 の「閉じる」のボタンの実装PR（pryusei/kokohima-app#139）のレビューで、iPhone のはみ出しは Chromium では再現しないと指摘された

## スコープ
- やること：
  - Playwright に、iPhone の端末の設定で WebKit を使うプロジェクトを足す
  - WebKit では、印（タグ）を付けた利用者の流れだけを回す
  - CI の E2E（mainへのPR）で WebKit も回す
  - T-11 の入力欄のはみ出しの確認を、WebKit で回す
  - ローカルで WebKit の E2E を回す手順を書く
- やらないこと（スコープ外）：
  - すべての E2E を WebKit で回すこと
  - Firefox、Android の Chrome、本物の iPhone（実機・クラウドの端末）でのテスト
  - 見た目の比較（スクリーンショットの差分）のテスト
  - アプリの画面の変更（WebKit で落ちる不具合が見つかったら、別のタスクにする）

## 受け入れ条件
- [ ] `pnpm e2e` で、Chromium のテストに加えて、印を付けたテストが WebKit（iPhone の端末の設定）でも回る
- [ ] mainへのPRの E2E で、WebKit のテストが回り、落ちたらマージできない
- [ ] T-11 の入力欄のはみ出しの指定を外すと、WebKit の E2E が落ちる（再現しない場合は、その理由を仕様書に書く）
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-21-webkit-e2e.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 関係するスキル：e2e-testing
- 設定：playwright.config.ts、.github/workflows/e2e.yml
