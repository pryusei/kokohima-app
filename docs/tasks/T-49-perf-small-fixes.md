# T-49 性能の小さな直し（zod の取り込み・資産のキャッシュ・4xx の再試行・遅延読み込み）

## 目的
Worker の大きさと起動、画面の再訪問の読み込み、見られない詳細画面での待ち、最初のチャンクの大きさを、振る舞いを変えずに小さく直す（pryusei/kokohima-app#197）。

## 関係する要件
- NF-01：Workers を基盤とする。NF-09：CPU 時間の制限
- T-12（docs/specs/T-12-release.md）、T-19（docs/specs/T-19-privacy-terms.md）

## スコープ
- やること：
  - zod の取り込みを `import * as z from "zod"` に揃え、lint で `import { z }` を止める
  - ハッシュ付きの `/assets/*` に `Cache-Control: public, max-age=31536000, immutable` を付ける
  - TanStack Query の既定：4xx は再試行しない、`staleTime` を30秒
  - プライバシー ポリシーと利用規約を `React.lazy` で別のチャンクにする
  - ビルドの前後の大きさを測って仕様書と PR に書く
- やらないこと（スコープ外）：
  - ほかのページの遅延読み込み、チャンクの分け方の設定
  - 本番の D1 の置き場所の確認（人がダッシュボードで見る）
  - Service Worker での資産のキャッシュ

## 受け入れ条件
- [x] `import { z } from "zod"` を書くと lint が落ちる。Worker の大きさが減る
- [x] `/assets/` の JS・CSS の応答に1年の immutable が付く。HTML と `/sw.js` は `no-cache` のまま
- [x] 見られない詳細画面（404）で再試行の待ちがない。通信できない・5xx は3回まで再試行する
- [x] `pnpm --filter web build` でチャンクの大きさの警告が出ない
- [x] 単体テストが追加され、通る
- [x] 仕様書でE2Eの対象にした流れのE2Eテストを足した（CI で回す）
- [x] 仕様書とコードに齟齬がない（仕様の変更は仕様書に反映済み）
- [x] typecheck・lint・関係するテストが通る

## 仕様書
- docs/specs/T-49-perf-small-fixes.md（持ち主の決定で、仕様書と実装を同じ PR にした）

## 参考
- 関係するスキル：data-fetching、vercel-react-best-practices（`bundle-dynamic-imports`）
