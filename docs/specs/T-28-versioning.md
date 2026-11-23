# T-28 仕様書：バージョンの管理とリリースのタグ

- 状態：下書き
- タスク票：docs/tasks/T-28-versioning.md
- 関係する要件：要求定義書「技術の選定」の監視、T-12 リリース、T-13 監視、T-18 画面のエラー

## 概要
今は、どのパッケージにも `version` がなく、git のタグもない。本番に何を出したかは、`deploy:prod` を実行した人の記憶にしかない。SemVer の番号を決め、GitHub Actions でタグとリリースを作り、ビルドに番号を埋め込む。障害のときに「どのリリースで起きたか」をログから引け、`wrangler rollback` で戻す先も番号で言えるようにする。

## 決めたこと（利用者の回答）
1. 番号は SemVer（`MAJOR.MINOR.PATCH`）。MVP の間は `0.x` のままにする。
2. タグは GitHub Actions のワークフローで作る（`workflow_dispatch`。人が番号を入れて実行する）。ワークフローは GitHub のリリースも作る。
3. ビルドにバージョンを埋め込む（画面と API の両方）。
4. すでに本番に出した最初のリリースに、さかのぼって `v0.1.0` を付ける。

## API

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| GET | `/api/v1/health` | なし | なし | 200 `{ "status": "ok", "version": "0.1.0+ec9fb17" }` | なし（今のまま） |

- `version` を足すだけ。`status` は今のまま（T-13 の外の監視は `/api/v1/health/ready` を見るので影響しない）。
- `GET /api/v1/health/ready` は変えない（D1 を読む経路の応答を増やさない）。

## データ
- D1 のテーブル・マイグレーションの変更はない。

## 振る舞い

### 1. 番号の決め方
- 正の置き場：ルートの `package.json` の `version`。`apps/*`・`packages/*` には `version` を書かない（`private` のまま。外に公開しないので、別々の番号は要らない）。
- 上げ方（`0.x` の間）：
  | 上げる桁 | いつ |
  | --- | --- |
  | MINOR（`0.1.0` → `0.2.0`） | 利用者に見える機能の追加・変更、D1 のマイグレーションを含むとき、API の互換を壊すとき |
  | PATCH（`0.1.0` → `0.1.1`） | 修正だけ（不具合・文言・依存の更新・セキュリティの修正） |
  | MAJOR（`1.0.0`） | 一般公開のとき（このタスクでは上げない） |
- タグの名前は `v` ＋ 番号（`v0.1.0`）。プレリリース（`-rc.1` など）とビルドのメタデータ（`+...`）はタグに付けない。
- `package.json` の `version` は「最後に出したリリースの番号」。リリースの前に、番号を上げる PR（題は「リリース：v0.2.0」）を出してマージする。

### 2. リリースのワークフロー（`.github/workflows/release.yml`）
- 起動：`workflow_dispatch` だけ。入力：
  - `version`（必須）：`X.Y.Z`（`v` を付けない）
  - `ref`（任意）：タグを付けるコミットの SHA（7〜40桁の16進）。省略したら main の先頭
- 実行できる場所：`github.ref` が `refs/heads/main` のときだけ（ほかのブランチから実行したら、何もせずに失敗する）。
- 権限：ジョブの `permissions` は `contents: write` だけ。ワークフローの既定は `contents: read`。アクションは今の CI と同じく SHA で固定する。
- 入力は `env:` で渡し、`run:` の中に `${{ inputs.* }}` を直接書かない（シェルの注入を防ぐ）。
- 検査（`scripts/release/check-release.mjs`。1つでも当たれば、タグを作らずに失敗し、理由を1行出す）：
  1. `version` が `^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$` に合わない。
  2. `ref` が `^[0-9a-f]{7,40}$` に合わない、またはコミットとして解決できない。
  3. `ref` のコミットが `origin/main` から届かない（`git merge-base --is-ancestor`）。
  4. タグ `v<version>` がすでにある。
  5. 既存の `v*` のタグ（SemVer として解釈できるものだけ）の最大以下の番号。
  6. `ref` のコミットの、ルートの `package.json` の `version` が入力と違う。ただし、`v*` のタグが1つもなく、そのコミットの `package.json` に `version` がないとき（最初の `v0.1.0` をさかのぼって付けるとき）だけは通す。
- タグ：`git tag -a v<version> <ref> -m "v<version>"`。作る人は `github-actions[bot]`。`git push origin refs/tags/v<version>` だけを push する（ブランチは push しない）。
- リリース：`gh release create v<version> --verify-tag --title v<version> --generate-notes`（前のタグからの、マージされた PR の一覧）。下書きにはしない。`0.x` でも `--prerelease` は付けない。
- 失敗したときに途中のものを残さない：タグの push のあとにリリースの作成が失敗したら、ワークフローを失敗にし、手順書のとおり人が `gh release create` をやり直す（タグは消さない。消すと、すでに取得した人と食い違う）。

### 3. ビルドへの埋め込み
- 埋め込む文字列（以下「アプリのバージョン」）：`<package.json の version>+<git の短い SHA（12桁）>`。git が使えないとき（CI の外で `.git` がないなど）は `<version>+<UTC のビルドの日時 YYYYMMDDHHmm>`。作るのは `scripts/release/app-version.mjs`（画面と API で同じものを使う）。
  - 正規表現：`^\d+\.\d+\.\d+\+([0-9a-f]{7,12}|\d{12})$`。
  - 未コミットの変更があっても、`-dirty` などは付けない（`deploy:prod` は未コミットの変更があると止まる。「4.」）。
- 画面：vite の `define` で `__APP_VERSION__` に入れる（T-18 の `appVersion` と同じ定数。T-18 の形を直す。「直す文書」）。Vitest の設定と `vite-env.d.ts` にも定義を足す（テストの値は `0.0.0+000000000000`）。
- API：`wrangler deploy` の `--var APP_VERSION:<アプリのバージョン>` で渡す（`build:prod` の `--dry-run` と `deploy:prod` の両方）。`wrangler.jsonc` の `vars` には書かない（書くと `--var` を忘れたときに古い値のまま出る）。
  - `Env` の `APP_VERSION` は任意（`string | undefined`）。ないとき（`wrangler dev`・E2E・単体テスト）は `"0.0.0+unknown"` として扱う。この値は正規表現の例外として、API の中でだけ使う。
- `GET /api/v1/health` の `version` と、`unhandled_error` のログ（`{ event, requestId, name, appVersion }`）に、API のアプリのバージョンを出す。ほかのログには足さない（T-13 のログの重さを増やさない）。
- 本番のビルドの検査（`check-web-dist`・`check-api-dist`）：画面の `dist` に `__APP_VERSION__` の文字が残っていない（置き換え忘れ）。API のビルドの検査は、`--var` は `dist` に入らないので足さない。

### 4. `deploy:prod` の検査（`check-wrangler-config.mjs --deploy` の続きに足す）
`deploy:prod` は、次のどれかに当たれば止まり、理由を1行出す：
- 作業ツリーに未コミットの変更がある（`git status --porcelain` が空でない。`.gitignore` されたファイルは見ない）。
- `HEAD` に `v*` のタグが付いていない（`git describe --exact-match --tags --match 'v*' HEAD`）。
- そのタグの番号と、ルートの `package.json` の `version` が違う（最初の `v0.1.0` のタグのコミットは `version` がないので、そのコミットからはもう一度デプロイできない。戻すときは `wrangler rollback` を使う。手順書）。
- 手元のタグが `origin` のタグと違う（`git ls-remote --tags origin v<version>` の SHA と `HEAD` が違う）。手元で勝手に付けたタグでデプロイしないように。
`build:prod`（CI）にはこの検査を付けない（CI はタグのないコミットもビルドする）。

### 5. リリースの流れ（手順書 `docs/runbooks/release.md`）
1. 次の番号を決める（「1.」の表）。前のタグからの PR は `git log v0.1.0..origin/main --oneline` で見る。
2. ルートの `package.json` の `version` を上げる PR（「リリース：v0.2.0」）を出し、CI が通ったらマージする。
3. GitHub の Actions で `release` を、ブランチ `main`・`version=0.2.0`（`ref` は空）で実行する。
4. 手元で `git fetch --tags origin && git checkout v0.2.0` をしてから `pnpm --filter api db:migrate:prod`（マイグレーションがあるとき）と `pnpm --filter api deploy:prod`。
5. デプロイのあとに確かめる：`curl https://kokohima.app/api/v1/health` の `version` が `0.2.0+<タグの短い SHA>`。T-12 の「デプロイのあとに確かめる」のうち、変えたところに関係する項目。
6. 問題があれば `wrangler rollback --env prod` で戻し、GitHub のリリースの本文に「戻した」と書き足す（タグは消さない）。直したら PATCH を上げて出し直す。

### 6. 最初の `v0.1.0`（実装PRのマージのあと、1回だけ）
1. 最初に本番にデプロイしたコミットを確かめる（Cloudflare の Workers の「Deployments」の日時と、main のコミットの日時を突き合わせる。はっきりしなければ `ec9fb17`（T-12 リリースの実装）にする）。
2. `release` を `version=0.1.0`・`ref=<そのコミット>` で実行する（「2.」の検査6の例外で通る）。
3. 実装PRで、ルートの `package.json` は `"version": "0.1.0"` にしておく（次の番号は、ここから上げる）。

## 認可と秘匿
- 閲覧者IDの使い方：変わらない（利用者のデータの取得を足さない）。
- 他人のデータに届かないことの保証：変わらない。`/api/v1/health` の `version` は誰に対しても同じ値で、利用者のデータを含まない。
- 区別させない応答：変わらない。
- バージョンを外に出すこと：画面の JavaScript にはもともと入る（T-18）ので、`/api/v1/health` に出しても新しく知られることはない。コミットの SHA から読めるのはリポジトリの履歴だけで、リポジトリは非公開。
- ワークフロー：タグを作れるのは、リポジトリの write の権限を持つ人が `main` から実行したときだけ。入力はシェルに直接埋め込まない。`GITHUB_TOKEN` の権限は、そのジョブの `contents: write` だけ。
- タグの保護（人が行う作業）：GitHub のリポジトリのルールセットで、`v*` のタグの作成・更新・削除を制限し、GitHub Actions（`github-actions[bot]`）だけを例外にする。設定できない場合（プランの制約など）は、手順書にその旨と、タグを手で作らない決まりを書く。
- ログ：アプリのバージョンは個人情報・トークンを含まない。

## テスト計画

### 単体テスト（実装PRで必須）
- [ ] 他人のIDでは取得・更新できない：対象外（利用者のデータの経路を足さない）。
- [ ] `check-release.mjs`（git を偽物にして、判定の関数を直接テストする）：
  - 正常系：タグがなく `package.json` に `version` がないコミットへの `0.1.0`。`package.json` が `0.2.0` のコミットへの `0.2.0`（既存の最大が `v0.1.0`）。
  - 入力検証：`v0.1.0`・`0.1`・`01.0.0`・`0.1.0-rc.1`・`0.1.0+x`・空・改行を含む値は失敗。`ref` の `main`・`HEAD~1`・`-n`・16進でない値は失敗。
  - 境界値：既存の最大と同じ番号・小さい番号は失敗。`v0.10.0` は `v0.9.0` より大きい（文字列の比較にしない）。SemVer でない `v*` のタグ（`vfoo`）は最大の計算に入れない。
  - タグがすでにある、main から届かない、`package.json` と違う（タグがあるのに `version` がない場合も含む）は失敗。
- [ ] `app-version.mjs`：git の短い SHA が取れるとき・取れないとき（日時）の形が正規表現に合う。`package.json` の `version` を読む。
- [ ] `GET /api/v1/health`：`APP_VERSION` があるときはその値、ないときは `0.0.0+unknown`。`status` は今のまま。
- [ ] `unhandled_error` のログに `appVersion` が付き、ほかの項目は今のまま（`health.test.ts` の既存のテストに足す）。
- [ ] `deploy:prod` の検査（git を偽物にする）：未コミットの変更・タグなし・タグと `package.json` の違い・`origin` のタグとの違いで止まる。全部そろえば通る。
- [ ] `check-web-dist`：`__APP_VERSION__` の文字が残った `dist` で止まる。
- [ ] ワークフローの検査（`check-wrangler-config` と同じく node のスクリプトで `release.yml` を読む）：`on` が `workflow_dispatch` だけ、ジョブの `permissions` が `contents: write` だけ、`run:` に `${{ inputs.` がない、`uses:` が SHA で固定。

### E2Eテスト（対象にする利用者の流れ）
- 対象なし：利用者の流れは変わらない（画面の見た目・操作に変更がない）。既存の E2E がすべて通ることを確かめる。

## 直す文書（実装PRで）
- docs/specs/T-18-client-errors.md：`appVersion` の形を `^\d+\.\d+\.\d+\+([0-9a-f]{7,12}|\d{12})$` に、作り方を「T-28 の `app-version.mjs`」に（T-18 は下書きで未実装なので、実装の前にそろえる）。
- docs/specs/T-12-release.md：「ビルドとデプロイのコマンド」の `build:prod`・`deploy:prod` に `--var APP_VERSION` と「4.」の検査。「人が行う作業」の手順8の前に「`release` でタグを作り、タグを checkout する」。「デプロイのあとに確かめる」に `version` の確認。
- docs/specs/T-13-monitoring.md：`GET /api/v1/health` の応答に `version`（「既存の `/api/v1/health` は変えない」の行を直す）。`unhandled_error` の項目に `appVersion`。
- docs/runbooks/monitoring.md：ログを `appVersion` で絞る手順。
- infra/README.md：デプロイの手順を `docs/runbooks/release.md` へのリンクに。
- README.md：「リリース」の節（手順書へのリンク）。

## スコープ外
- CHANGELOG.md（GitHub のリリースの自動の変更点を使う）。
- タグを付けたら自動でデプロイすること（デプロイは人が `deploy:prod` を実行する。T-12）。
- 設定の「このアプリについて」へのバージョンの表示（T-19 の実装のあとに検討）。
- workspace の各パッケージごとのバージョン、npm への公開。
- 1.0.0 にする時期（一般公開のときに決める）。

## 確認事項（合意前に解消する）
- 最初にデプロイしたコミット：`ec9fb17`（T-12 リリースの実装）でよいか。その後に `1beb3cf` などもデプロイしていれば、最後にデプロイしたコミットに `v0.1.0` を付けるほうがよい（利用者に確かめる）。
- タグの保護のルールセットを、このリポジトリのプランで設定できるか（設定するのは人）。

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 下書き | 利用者の依頼（バージョンの管理とタグ） |
| 2026-11-23 | タスク ID を T-23 に変えた（T-21 は iPhone の Safari の E2E（#141）、T-22 は行きたいリスト（#142）と重なった） | main との重なり |
| 2026-11-23 | タスク ID を T-28 に変えた（T-23〜T-27 も main で使われた） | main との重なり |
