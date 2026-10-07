---
name: e2e-testing
description: PlaywrightでE2Eテストを書く・直すときの方針（認証の使い回し、テスト用ログイン、外部サービスの差し替え、ロケーター、分離）
---
# E2Eテスト（Playwright）

Playwright公式のベストプラクティス（playwright.dev/docs/best-practices、/docs/auth）に沿う。

## 対象
- 仕様書のテスト計画で「E2E」にした利用者の流れだけを書く。細かい分岐や境界値は単体テストで確かめる
- 利用者に見える振る舞いを確かめる。関数名やCSSクラスなどの実装の詳細に依存しない

## 認証
- 本物のGoogle／Appleにはログインしない（自分たちが管理していない外部サービスはテストしない）
- E2E環境でのみ有効なテスト用ログイン（`POST /__e2e__/login`）で、テスト用ユーザーの更新用トークンCookieを発行する
- IMPORTANT: 認証状態（`storageState`）をテストの間で使い回さない。更新用トークンはページを開くたびに交換され、同じトークンを別のテストが送ると再利用として系列ごと失効するため
- `e2e/fixtures.ts` の `loggedInPage`（ユーザーAとしてログイン済みのページ）か `loginAs(context, name)` を使い、テストごとに一意なユーザー（`<name>-<uuid>`）で新しいセッションを作る
- 友達同士の流れでは、同じテストの中でA・B・Cを別々のブラウザコンテキスト（`browser.newContext()`）で作り、それぞれ `loginAs` する
- `playwright/.auth/` はコミットしない（使う場合も）
- アクセストークンはメモリ保持なので、ページを開くと更新用トークンCookieから取り直す。この動き自体が「再読み込みでログインが続く」の確認になる

## テスト用ログインの安全策（すべて必須）
- テスト用の経路は `apps/api/src/e2e/` に置き、E2E用のエントリからだけimportする。本番のエントリからはimportしない
- E2E用のwrangler環境（`env.e2e`）でだけ使い、さらに `E2E_MODE=1` のときだけ有効にする
- E2E用の秘密情報は `apps/api/scripts/write-e2e-dev-vars.mjs` がその場で生成する（`.dev.vars.e2e`。コミットしない）
- CIで本番のビルド成果物に `__e2e__` とテスト用ログインの関数名（`e2eLogin`）が含まれていないことを確認する。本番のコードに `__e2e__` という文字列を書かない

## 外部サービス
- Google Calendar、iCloud CalDAV、メール配信、Webプッシュ、OGP取得先は、E2E環境では偽の実装に差し替える（calendarなどのinfra層のアダプターを入れ替える）
- 偽の実装は、テストから状態を設定・確認できるようにする（例：「この時間に予定を入れる」「送られたメールを取得する」）
- 本物の外部サービスとの接続は、単体テスト（署名検証など）と手動確認で担保する

## 分離
- 各テストは独立して動くこと。前のテストの状態に依存しない
- データはテストごとに一意なユーザーや誘いを作る（並列実行でぶつからない）
- 共通の前処理は `beforeEach` やfixtureにまとめる

## 書き方
- ロケーターは `getByRole`・`getByLabel`・`getByText` を優先する。足りないときだけ `data-testid`。CSSクラスやXPathは使わない
- アサーションは自動で待つもの（`toBeVisible`、`toHaveText` など）を使う。固定のwaitは使わない
- CIではリトライ時だけトレースを取る（`trace: 'on-first-retry'`）
- 失敗の調査は `pnpm exec playwright test --debug` とトレースビューアーで行う
