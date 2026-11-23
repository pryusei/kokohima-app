# T-49 仕様書：性能の小さな直し（zod の取り込み・資産のキャッシュ・4xx の再試行・遅延読み込み）

- 状態：実装済み
- タスク票：docs/tasks/T-49-perf-small-fixes.md
- 関係する要件：NF-01（Workers を基盤とする）・NF-09（CPU 時間の制限。性能だけの要件の番号はない）。pryusei/kokohima-app#197（親 #178）
- 関係する仕様書：T-12（docs/specs/T-12-release.md「セキュリティのヘッダー」のキャッシュ）、T-19（docs/specs/T-19-privacy-terms.md「1.」の遅延読み込み）、T-12-data-growth（スコープ外にしていたフロントエンドの2つ）

## 概要
2026-11-23 のレビュー（観点5：性能）で、ビルドして測って見つかった4つを直す。Worker に zod の使わない部分（言語のファイル）が入っている、ハッシュ付きの資産が開くたびに再検証される、見られない詳細画面（404）で TanStack Query が3回再試行して待たされる、画面の JS が1つのチャンクで 500kB を超えて警告が出る。どれも、画面と API の見た目・応答の中身は変えない。

この PR は、持ち主の決定で、仕様書と実装を同じ PR にする（CLAUDE.md の「1タスク2PR」の例外）。

## API
変えない（応答のヘッダー `Cache-Control` だけ、画面の側の `/assets/` で変わる。下の「2.」）。

| メソッド | パス | 認証 | 入力（Zodスキーマ名） | 出力 | 主なエラー |
| --- | --- | --- | --- | --- | --- |
| （なし） | | | | | |

## データ
なし（マイグレーションなし）。

## 振る舞い

### 1. zod の取り込み
- `packages/shared`・`apps/api`・`apps/web` の TypeScript で、zod は `import * as z from "zod"`（型だけなら `import type * as z from "zod"`）で読む。`import { z } from "zod"` は使わない。
  - `import { z }` は zod の名前空間をまとめた値を読むので、木の剪定（tree shaking）が効かず、使わない言語のファイル（`zod/v4/locales` の64本）まで Worker に入る。
  - 名前付きの関数（`apps/web/src/zodConfig.ts` の `config`）・型（`ZodType`）の取り込みは今のまま。
- ESLint の `no-restricted-syntax` で、`zod` からの `z` の名前付きの取り込み（`import { z }`・`import type { z }`）を止める（`eslint.config.js`。`no-restricted-imports` の `importNames` は `import * as z` も止めてしまうので使わない）。
- 検証の結果は変わらない（同じスキーマを同じ関数で使う）。

### 2. ハッシュ付きの資産のキャッシュ
- 画面の側（`/api/` 以外で `ASSETS` がある環境）の応答のうち、パス（デコードしない `URL.pathname`）が `/assets/` で始まり、状態が200か304で、HTML でない（T-12 の `isHtml` の判定）応答に `Cache-Control: public, max-age=31536000, immutable` を付ける（静的アセットの既定の `public, max-age=0, must-revalidate` を上書きする）。
  - `/assets/` には vite がハッシュ付きの名前のファイル（JS・CSS）だけを出す。中身が変わると名前が変わるので、1年持たせてよい。`apps/web/public` のファイル（`/icon.svg`・`/manifest.webmanifest` など、ハッシュが付かない）は `/assets/` の外にある。
  - 見つからない `/assets/…` は SPA の振り分けで `index.html`（`text/html`）が返る。これは HTML なので、今のまま `no-cache`（長く持たせない）。
  - 405・リダイレクト・404 など、200・304 以外は触らない。
- `/sw.js` と HTML の `no-cache` は今のまま（T-12）。
- 置き場は `apps/api/src/http/securityHeaders.ts` の `withPageHeaders`（値は `IMMUTABLE_ASSET_CACHE`）。

### 3. TanStack Query の既定
- `apps/web/src/queryClient.ts` の `createQueryClient` の既定（クエリだけ。ミューテーションは今のまま再試行しない）：
  - `retry`：失敗が `ApiError` で、状態が400〜499なら再試行しない（見られない・ない・回数の上限などは、何度読んでも同じ）。ほかの失敗（通信できなかった＝状態0・5xx・API の外の失敗）は3回まで再試行する（今の既定と同じ回数。待ち方も TanStack の既定のまま）。
  - `staleTime`：30秒。30秒の間は、画面を移っても・ウィンドウに戻っても取り直さない。更新のあとに `invalidateQueries` で取り直す今の作りはそのまま効く。
  - `refetchOnWindowFocus: true` は今のまま（30秒を過ぎていれば、ウィンドウに戻ったときに取り直す）。
- クエリごとに `retry` を書いているもの（`wish/queries.ts` の `wishQuery`・`friendWishesQuery`、`availability/queries.ts` の「みんな」）は今のまま（既定より優先される）。
- 見られない詳細画面（404）は、再試行の待ち（約7秒）なしに、今と同じ表示になる。

### 4. プライバシー ポリシーと利用規約の遅延読み込み
- `/privacy`（`PrivacyPage`）と `/terms`（`TermsPage`）だけを `React.lazy` で読み、別のチャンクにする（T-19「1.」を改める）。ほかのページは今のまま。
  - 本文が合わせて約42kB あり、開く人が少ない。最初のチャンクが 500kB を下回り、vite のチャンクの大きさの警告が消える。
  - 共通の部品（`LegalDocument.tsx`・`legal.ts`）はログインの画面・招待の画面の `LegalLinks` が使うので、最初のチャンクに残る。制定日などの行の検査（`check-web-dist.mjs`）と、本番に予告が出ているかの確かめ（`findPublishedStrings`。読み込む chunk をたどる）は、チャンクが分かれても今のまま効く。
- 読んでいる間は、ログインの確認中と同じ読み込み中の形（`Loading`）を出す。ログインの状態によらず描画する位置（T-19「1.」）は変えない。
- チャンクを読めなかったとき（オフライン、デプロイでファイルの名前が変わった）は、画面を落とさず、静かな文言「読み込めませんでした。通信状態を確認して、もう一度お試しください」と「もう一度」のボタン（`LoadError`。エラーの色・`alert` は使わない）を出す。「もう一度」はページを読み直す（`React.lazy` は失敗を覚えるため）。
- 置き場は `apps/web/src/ui/lazyPage.tsx`（`lazyPage`・`ChunkLoadError`）と `apps/web/src/App.tsx`。
- 遅延読み込みは `React.lazy` を使う（CLAUDE.md「UI」。Next.js の `next/dynamic` は使わない）。チャンクは同じオリジンの `/assets/` から読むので、CSP（`script-src 'self'`）は変えない。

### 5. 測った大きさ（実装 PR で、`pnpm --filter web build` と `pnpm --filter api build:prod`）

| | 前 | 後 |
| --- | --- | --- |
| Web の最初のチャンク（`index-*.js`） | 531.52 kB（gzip 153.11 kB）、チャンクの大きさの警告あり | 491.52 kB（gzip 142.94 kB）、警告なし |
| Web の遅延読み込みのチャンク | なし | `PrivacyPage-*.js` 33.84 kB（gzip 9.03 kB）、`TermsPage-*.js` 8.67 kB（gzip 2.77 kB） |
| Worker（`wrangler deploy --dry-run` の Total Upload） | 2582.75 KiB（gzip 465.23 KiB） | 2010.05 KiB（gzip 385.63 KiB） |

- Web の zod の取り込みの変更だけでは、Web のチャンクは変わらなかった（vite が剪定できていた）。Worker は zod の変更で 2009.83 KiB（gzip 385.56 KiB）になった。

## 認可と秘匿
- 閲覧者IDの使い方：変えない（API の取得・権限の条件は触らない）。
- 他人のデータに届かないことの保証：変えない。`immutable` を付けるのは画面の側の `/assets/` の公開の資産だけで、API の応答（`/api/`）のヘッダーは今のまま（経路が付けた `Cache-Control` を上書きしない）。個人のデータを含む応答を長く持たせない。
- 区別させない応答（見せない／暇がない／募集の応答者など）：4xx を再試行しないのは状態の数だけで決め、`code` や本文で分けない。見られない（404）の画面の表示は今と同じ。
- TanStack Query のキャッシュは今のまま永続化しない（メモリだけ。`staleTime` はメモリの中の時間）。ログアウトで `queryClient.clear()` する作りも今のまま。

## テスト計画

### 単体テスト（実装PRで必須）
- [x] キャッシュ：`/assets/` の200（JS・CSS）と304に `public, max-age=31536000, immutable`（偽の `ASSETS` が `max-age=0, must-revalidate` を返しても上書きする）
- [x] キャッシュ：見つからない `/assets/…`（SPA の `index.html`）は `no-cache`。`/assets/` の POST（405）・リダイレクトは触らない。`/icon.svg`（`/assets/` の外）は既定のまま。`/%61ssets/` はデコードしない
- [x] キャッシュ：`/sw.js` と HTML の `no-cache`、API の応答の扱いは今のまま（既存のテストが通る）
- [x] 再試行：`ApiError` の400・401・403・404・409・429・499は再試行しない。状態0・500・503・API の外の失敗は3回まで（4回めはしない）
- [x] 既定：`staleTime` が30秒、`refetchOnWindowFocus` が true、`retry` が上の関数
- [x] 遅延読み込み：読めたら名前付きの export のページを出す。読めなかったら静かな文言と「もう一度」（`alert` を使わない）。「もう一度」でページを読み直す
- [x] 遅延読み込み：プライバシー ポリシーと利用規約の既存のテスト（ログインの4つの状態で本文が出る、見出し、タブの題、戻る、オフライン）が通る
- [x] zod：`import { z } from "zod"` を lint で止める（`pnpm lint` が通り、`import { z }`・`import type { z }` を書くと `no-restricted-syntax` で落ちることを手元で確かめた）
- [x] 他人のIDでは取得・更新できない（API を足さない。既存のテストが通る）

### E2Eテスト（対象にする利用者の流れ）
- [x] 本番と同じ形（`e2e/release.spec.ts`、`--env assets`）：`/privacy` を開くと、読み込んだ `/assets/` の JS・CSS（遅延読み込みのチャンクを含む）がすべて `public, max-age=31536000, immutable`、`/sw.js` が `no-cache`
- 本番と同じ形で `/privacy`・`/terms` を開いて本文が出て CSP の違反がないことは、既存のテストが遅延読み込みのチャンクも含めて確かめる。

## スコープ外
- ほかのページの遅延読み込み、チャンクの分け方の設定（`codeSplitting`）。
- 本番の D1 の置き場所の確認（issue #197 の「確かめること」。ダッシュボードで人が見る。Terraform に指定がない）。
- Service Worker での資産のキャッシュ（オフラインでの起動）。
- zod の `zod/mini` への移行。

## 確認事項（合意前に解消する）
- （なし。持ち主の決定で仕様書と実装を同じ PR にした）

## 変更履歴
| 日付 | 変更内容 | 理由 |
| --- | --- | --- |
| 2026-11-23 | 作成し、実装した（仕様書と実装を同じ PR）。T-12-release.md のキャッシュ、T-19 の遅延読み込み、T-12-data-growth のスコープ外、`data-fetching` スキルを直した | pryusei/kokohima-app#197（レビュー 観点5） |
