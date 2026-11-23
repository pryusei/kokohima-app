# T-30 CI の見直し（テストを回すタイミングと中身）

## 目的
実装PRに単体テストがないこと、E2E の flaky、マージ後の main の壊れに、CI で確実に気づけるようにする。あわせて、重複した実行と要らない実行をなくし、待ち時間を減らす。

## 関係する要件
- 要求定義書「技術」：CI（GitHub Actions＋依存更新の自動プルリクエスト）
- CLAUDE.md「テスト」：実装PRには単体テストの追加が必須。CI を回すタイミング
- T-21（docs/specs/T-21-webkit-e2e.md）：WebKit の E2E

## スコープ
- やること：
  - 単体テストの検査（`require-unit-tests`）を、ブランチ名ではなく差分で判定する
  - ci を PR と main への push で回し、同じ PR の古い実行を取り消す
  - 文書（`docs/` と `.md`）だけの変更では、単体テストと E2E を飛ばす
  - E2E を main への push でも回す。手動でも回せるようにする
  - E2E を Playwright の公式のコンテナで回し、OS の依存パッケージを取得する時間をなくす
  - CI で flaky を失敗にし、今の flaky（`e2e/navigation.spec.ts`、WebKit）を直す
  - terraform の整形・検証を、承認の前に回す
  - CLAUDE.md・`e2e-testing` スキル・T-21 の仕様書を、新しい CI に合わせる
- やらないこと（スコープ外）：
  - 単体テストのジョブの分割、カバレッジの計測、E2E の毎晩の実行
  - ブランチ保護の設定の変更（GitHub の設定。人が行う）
  - アプリの振る舞いの変更（flaky の原因がアプリにあったときを除く）
  - Dependabot の jsdom の更新の失敗（別の作業）

## 受け入れ条件
- [ ] ブランチの名前（`claude/*`・`fix/*` など）によらず、コードを変えて単体テストを足していない PR では `require-unit-tests` が落ちる
- [ ] 文書だけの PR では `unit` と `e2e` が飛ばされ、マージできる
- [ ] PR のブランチに push すると、ci は1本だけ走る。続けて push すると、古い実行が取り消される
- [ ] main にマージすると、ci と E2E が走る
- [ ] E2E が `playwright install --with-deps` を実行せずに回る
- [ ] CI で flaky のテストがあると、E2E が落ちる
- [ ] `navigation.spec.ts` の「誘いの URL を直接開いて閉じる」テストが、WebKit で繰り返し回しても落ちない
- [ ] terraform の `fmt`・`validate` が、承認を待たずに回る
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-30-ci-review.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- 関係するスキル：e2e-testing、infra-change（terraform のワークフロー）
- 設定：.github/workflows/ci.yml、.github/workflows/e2e.yml、.github/workflows/terraform.yml、playwright.config.ts、vitest.config.ts
