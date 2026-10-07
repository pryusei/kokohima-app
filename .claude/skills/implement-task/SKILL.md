---
name: implement-task
description: タスク票を、仕様書PR → マージ後に実装PR の2段階で進める
disable-model-invocation: true
---
# タスクの実装: $ARGUMENTS

## ① 仕様書PR（コードは含めない）
1. タスク票と、関係する要件（docs/requirements.md の F-xx）、関係するスキルを読む
2. ブランチ `spec/T-xx-<名前>` を作り、`docs/specs/_TEMPLATE.md` をもとに `docs/specs/T-xx-<名前>.md` を書く
3. API、データ、振る舞い、認可、テスト計画（単体・E2E）、スコープ外を埋める。要件にないことは「確認事項」に書く
4. 仕様書だけのPRを作成して終える。実装はこのPRがマージされるまで始めない

## ② 実装PR（①のマージ後）
5. マージ済みの仕様書を読み、ブランチ `feat/T-xx-<名前>` を作る
6. 仕様書どおりに実装し、単体テストを必ず追加する。仕様書でE2Eの対象にした流れはE2Eテストも追加・更新する
7. 仕様の変更が必要になったら、このPRの中で仕様書（必要なら docs/requirements.md も）を修正し、変更履歴に理由を書く
8. typecheck・lint・単体テスト・関係するE2Eを実行し、すべて通るまで直す。security-guidance プラグインの指摘はその場で直す
9. spec-reviewer と security-reviewer のサブエージェントで差分をレビューし、正確性・要件・仕様書との一致に関わる指摘だけ直す
10. `/security-review` でブランチ全体を確認する
11. 実行したコマンドと結果、受け入れ条件ごとの確認結果をPRの説明に書き、仕様書の状態を「実装済み」にしてPRを作成する
