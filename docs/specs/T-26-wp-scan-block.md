# T-26 仕様書：WordPress系スキャンのエッジでの遮断

- 状態：下書き
- タスク票：docs/tasks/T-26-wp-scan-block.md
- 関係する要件：NF-02、要求定義書「AI時代の攻撃を前提にした運用」

## 概要
- 本番のログに、`/wp-admin/install.php`・`/wp-login.php` などWordPress向けのスキャンが毎日届く。このアプリはWordPressではなく、該当するページもない。
- いまは、これらがWorkerに届き、`env.ASSETS.fetch` で静的アセットを引いたうえでセキュリティのヘッダーを付けて返している（`apps/api/src/worker.ts`）。外部のホストへは転送していない。
- WorkerよりCloudflareのWAFで先に遮断する。Workerの実行とログのノイズが減る。アプリのコード・画面・APIの振る舞いは変えない。

## API
追加・変更なし（インフラのみ）。

## データ
なし。マイグレーションなし。

## 振る舞い
- 対象ゾーン：`kokohima.app`（本番のみ。stagingは対象外）。
- Terraform（`infra/terraform/envs/prod`）に、WAFのカスタムルール（`cloudflare_ruleset`、フェーズ `http_request_firewall_custom`）を1つ足す。
- 条件（式）：URIのパスが次のどれかで始まる、または一致する。
  - `/wp-admin`、`/wp-login.php`、`/wp-content`、`/wp-includes`、`/wp-json`
  - `/xmlrpc.php`
- アクションは `block`（403）。遮断した応答の中身は決めない（Cloudflareの既定）。
- 画面・APIで使うパスと重ならない。アプリのパスは `/`、`/api/`、ビルド済みの静的ファイル（`/assets/` など）、`/sw.js`、`/manifest.webmanifest`、`/icon.svg` などで、`/wp-` と `/xmlrpc.php` で始まるものはない。
- 将来 `/wp-` で始まるパスをアプリで使うときは、このルールを先に直す。
- Terraformの記述は、Cloudflareプロバイダv5の公式ドキュメントでスキーマを確かめてから実装PRで書く。
- `terraform apply` は人が行う。

## 認可と秘匿
- 閲覧者IDの使い方：なし（利用者のデータを扱わない）。
- 他人のデータに届かないことの保証：データを扱うAPIを足さない。ルールは公開のパスのみを対象にする。
- 区別させない応答：該当なし。遮断は利用者・募集・友達関係と無関係。
- ログにはパスと国など、既存のものだけが残る。個人情報・トークンを足さない。

## テスト計画

### 単体テスト（実装PRで必須）
インフラのみで、アプリのコードを足さないため、アプリの単体テストの対象はない。代わりに、実装PRで次を確かめる。
- [ ] `terraform fmt -check` と `terraform validate` が通る
- [ ] 式がアプリの実在するパス（`/`、`/api/v1/health/ready`、`/sw.js`、`/manifest.webmanifest`、`/icon.svg`）に一致しないことを、パスの一覧に対して確かめる（`infra/terraform` の外の簡単なスクリプトか、手順書の確認）
- [ ] `plan` の結果をPRに貼る。差分がルール1つの追加だけで、D1などの置き換え・削除がない

### E2Eテスト
- 対象なし。理由：ユーザーの流れが変わらない。ルールはCloudflareのエッジで動き、ローカルとE2E（wrangler dev）には存在しない。apply後に、人が本番で `/wp-login.php` が403になることと `/` が200のままであることを確かめる。

## スコープ外
- Bot対策（Bot Fight Mode など）、WAFのレート制限、IP・国・UAでの遮断
- Worker側での `/wp-` の404返し（WAFで遮断するので不要）
- 静的アセットにない任意のパスを404にする変更

## 確認事項（合意前に解消する）
- 遮断のアクションは `block` でよいか。ログだけ残す `log` で様子を見てから `block` にする案もある。
- 対象に `/wp-json` を入れてよいか。入れない場合は、ほかのパスだけにする。
- 本番の apply 後の確認を、`docs/runbooks/` に足すか。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 下書きを作成 | 本番ログにWordPress系スキャンが多いため（Cloudflare Observability の調査） |
