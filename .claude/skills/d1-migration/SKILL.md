---
name: d1-migration
description: D1のスキーマ変更（マイグレーション作成と適用）
disable-model-invocation: true
---
# D1マイグレーション: $ARGUMENTS

1. `migrations/` に新しい連番ファイルを作る。適用済みのファイルは編集しない
2. 既存データを壊さない変更にする（列の追加は既定値つき、削除は2段階）
3. `pnpm db:migrate:local` で適用し、関係するテストを実行する
4. 本番への適用はしない。適用コマンドと影響をまとめて報告する
