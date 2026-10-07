# ここ暇

友達を誘う気まずさをなくすPWA。Cloudflare Workers上のTypeScriptモジュラーモノリス。
スタック：pnpmモノレポ（apps/web＝React＋Vite、apps/api＝Hono、packages/shared＝Zodスキーマと型）、D1＋Drizzle、TanStack Query、Vitest（単体）、Playwright（E2E）、jose。
仕様の正は `docs/requirements.md` と `docs/specs/`。仕様書とコードは常に一致させる。

## コマンド
- `pnpm dev`：ローカル起動（API＝wrangler dev :8787、Web＝vite :5173。`/api` はviteがAPIへ中継）
- `pnpm test <path>`：単体テスト（Vitest。apiはWorkersのランタイム上で動く）。全体ではなく関係するファイルだけ実行する
- `pnpm e2e`：E2Eテスト（Playwright。APIを `--env e2e` で、Webをviteで自動起動する）
- `pnpm typecheck` / `pnpm lint`（ESLint。`pnpm lint --fix` で自動修正）
- `pnpm db:migrate:local`：D1マイグレーション（`apps/api/migrations/`）をローカルに適用
- `pnpm --filter api build:prod`：本番のビルド（`wrangler deploy --dry-run`。デプロイはしない）

## アーキテクチャ
- `apps/api/src/<context>/{domain,application,infra}`。contextは invitation / availability / social / calendar / notification / link-preview / identity
- IMPORTANT: `domain/` はCloudflare・D1・Hono・fetchをimportしない。純粋なTypeScriptに保つ
- 状態遷移は集約のメソッド経由のみ。D1の更新は `WHERE status = ?` の条件付きUPDATEにする
- 外部連携（通知・OGP・カレンダー書き込み）はoutboxテーブル経由でQueuesへ。APIハンドラから直接呼ばない
- 誘い・募集のルールは `invitation-domain` スキルを読んでから触る
- 入力検証のZodスキーマは `packages/shared` に置き、APIとフロントで共有する
- APIのパス・ID・日時・ページング・エラー形式は `api-conventions` スキルに従う
- インフラは `infra/terraform`（Cloudflareのリソース）とwranglerの設定（Workers）でコード管理する。変更は `infra-change` スキルに従い、apply・deploy は実行しない

## セキュリティ（例外なし）
- IMPORTANT: データ取得は必ず閲覧者IDを引数に取り、友達関係と公開設定の条件をSQLに組み込む。新しいAPIには「他人のIDでは取得できない」テストを必ず書く
- 「見せない相手」と「暇がない相手」、募集の応答者の有無を、レスポンスの形・項目・エラーで区別できないようにする
- アクセストークンはメモリのみ。localStorage・sessionStorageに保存しない
- 秘密情報は `wrangler secret` だけで扱う。`.dev.vars` はコミットしない
- ログとエラーメッセージに、個人情報・トークン・カレンダーの認証情報を出さない
- 予定の中身（タイトル・場所・参加者）は取得も保存もしない。空き／埋まりのみ

## UI
- Reactは `vercel-react-best-practices` と `vercel-composition-patterns` スキルに従う。ただしこのプロジェクトはVite（SSRなし）なので、`server-` で始まるルールとNext.js固有の書き方（next/dynamic など）は適用せず、遅延読み込みは `React.lazy` を使う
- データ取得はTanStack Query（`data-fetching` スキル）。SWRは使わない
- 断り・期限切れ・キャンセルに赤やエラー色を使わない。静かな状態として表示する
- 画面の文言とコードの名前は `invitation-domain` スキルの用語表に合わせる

## 仕様書とPRの流れ（例外なし）
- IMPORTANT: 1タスクはPRを2つに分ける。①仕様書PR：`docs/specs/` に仕様書を追加するだけ（`_TEMPLATE.md` を使う）②実装PR：①がマージされてから作る
- 実装中に仕様の変更が必要になったら、実装PRの中で仕様書（必要なら `docs/requirements.md` も）を一緒に修正し、コードと仕様書の齟齬を残さない
- 仕様書に書かれていない振る舞いを実装しない

## テスト
- IMPORTANT: 実装PRには単体テストの追加が必須。テストを追加しないPRは出さない
- E2Eテストは、仕様書で対象にした利用者の流れ（ログイン、誘い〜成立など）について追加・更新する。書く前に `e2e-testing` スキルを読む
- CIはpushごとに型チェック・lint・単体テスト、mainへのPRでE2Eを実行する。PRの説明は `.github/pull_request_template.md` に沿って書く

## 進め方
- ブランチは仕様書PRが `spec/T-01-auth`、実装PRが `feat/T-01-auth` のようにタスクIDを含める。コミットは小さく
- 完了と言う前に typecheck・lint・関連テストを実行し、コマンドと結果を示す
- コンパクション時は、変更したファイルの一覧・実行中のタスクID・仕様書のパス・テストコマンドを必ず残す
