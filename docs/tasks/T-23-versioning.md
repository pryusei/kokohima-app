# T-23 バージョンの管理とリリースのタグ

## 目的
本番に出したものに番号（SemVer の `v0.x.y`）を付け、git のタグと GitHub のリリースで「いつ・何を出したか」を追えるようにする。ビルドにバージョンを埋め込み、ログ・死活確認・画面のエラー（T-18）から、どのリリースで起きたかを引けるようにする。

## 関係する要件
- 要求定義書「技術の選定」の監視（障害がどのリリースで起きたかを引く）
- T-12 リリース（`deploy:prod`・デプロイのあとの確認・`wrangler rollback`）
- T-13 監視（`unhandled_error` のログ）、T-18 画面のエラー（`appVersion`）

## スコープ
- やること：
  - バージョンの決め方（SemVer 0.x。上げ方の基準）と、正の置き場（ルートの `package.json` の `version`）
  - GitHub Actions のリリースのワークフロー（`workflow_dispatch`）：注釈付きのタグ `vX.Y.Z` と、変更点を自動で作った GitHub のリリース
  - すでに本番に出した最初のリリースに、さかのぼって `v0.1.0` を付ける
  - ビルドへのバージョンの埋め込み（画面の `__APP_VERSION__`、API の `APP_VERSION`）。`GET /api/v1/health` と `unhandled_error` のログに出す
  - `deploy:prod` を、タグの付いたコミットからだけ実行できるようにする検査
  - リリースの手順書（`docs/runbooks/release.md`）
- やらないこと（スコープ外）：
  - CHANGELOG.md（GitHub のリリースの自動の変更点で足りる）
  - タグを付けたら自動でデプロイする仕組み（デプロイは今までどおり人が `deploy:prod` を実行する）
  - 設定の「このアプリについて」にバージョンを出すこと（T-19 の実装のあとに検討）
  - workspace の各パッケージ（`apps/*`・`packages/*`）ごとのバージョン

## 受け入れ条件
- [ ] ルートの `package.json` に `"version": "0.1.0"` がある
- [ ] リリースのワークフローを `version=0.1.0`・`ref=<最初にデプロイしたコミット>` で実行すると、そのコミットに注釈付きのタグ `v0.1.0` と GitHub のリリースができる
- [ ] 2回目以降は、`package.json` の `version` を上げる PR をマージしてから、main の先頭に対して実行するとタグとリリースができる
- [ ] 形の違う番号・すでにあるタグ・前のタグ以下の番号・`package.json` と合わない番号・main にないコミット・main 以外からの実行は、タグを作らずに失敗する
- [ ] `GET /api/v1/health` が `{ "status": "ok", "version": "<X.Y.Z+短いSHA>" }` を返す
- [ ] `unhandled_error` のログに `appVersion` が付く
- [ ] タグの付いていないコミット・未コミットの変更がある状態で `deploy:prod` を実行すると止まる
- [ ] 単体テストが追加され、通る
- [ ] 仕様書でE2Eの対象にした流れのE2Eテストが通る（対象なし。仕様書に理由）
- [ ] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [ ] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-23-versioning.md（仕様書PRとして先に追加し、マージ後に実装PRを作る）

## 参考
- docs/specs/T-12-release.md（ビルドとデプロイのコマンド、人が行う作業）
- docs/specs/T-13-monitoring.md、docs/specs/T-18-client-errors.md（`appVersion`）
- 関係するスキル：`infra-change`（wrangler の設定）、`api-conventions`（health の応答）
