# T-00 技術検証：IaCツールの選定（Alchemy／Terraform）

## 目的
インフラをコードで管理するツールを、AlchemyとTerraformのどちらにするか、根拠を持って決める。
成果物は本番用のコードではなく、検証結果と決定記録（`docs/decisions/0001-iac-tool.md`）。

## 背景
- Terraform：安定していて実装LLMも正確に書けるが、作ったリソースのIDをwranglerの設定に転記する必要がある
- Alchemy：TypeScriptだけで書け、wranglerとのつなぎ目がなくなる。一方で変化が速く（v1とv2で書き方が大きく違う）、開発モードはベータ

## 関係する要件
- 要求定義書「技術選定」のIaC
- NF-01（Cloudflareの構成）、セキュリティ設計（WAF、レート制限、運営機能の保護）

## スコープ
- やること：
  - 検証用の使い捨てのCloudflareアカウント（または検証用の名前空間）で、両方のツールで同じ最小構成を作って比べる
  - 最小構成：Worker（Hono）、D1、KV、R2、Queues（＋失敗時の退避キュー）、Cronのバインディング、staging・prodの2環境
- やらないこと：
  - アプリの機能の実装
  - 本番のリソースの作成

## 判断基準（各項目を ○／△／× で記録）
1. Worker・D1・KV・R2・Queues・Cronのバインディングまで一通り定義できるか
2. WAFのルールとレート制限を定義できるか（Alchemyは Ruleset がフェーズ全体を上書きする点も確認）
3. 状態の保存先をCloudflare上に置き、staging・prodを分けられるか
4. D1の削除・置き換えを防げるか（Terraformの `prevent_destroy` に当たるもの）
5. CIで差分の確認（plan）だけを実行し、適用は人が行う運用にできるか
6. 秘密情報を状態やコードに残さずに扱えるか
7. 実装LLM（Claude Code）に書かせたとき、公式ドキュメントどおりの書き方になるか（Alchemyはv1とv2の混同がないか）
8. ローカル開発（wrangler dev相当）とE2E環境が問題なく動くか

## 決め方
- 1〜6がすべて ○ ならAlchemy、どれかが × ならTerraform
- △ がある場合は、回避策と運用コストを決定記録に書いて判断する

## 受け入れ条件
- [ ] 両方のツールで最小構成を作った結果（手順、つまずいた点、所要時間）が記録されている
- [ ] 判断基準の8項目すべてに ○／△／× と根拠がある
- [ ] `docs/decisions/0001-iac-tool.md` に決定と理由が書かれ、合意されている
- [ ] 決定に合わせて、要求定義書の技術選定・`infra/`・CLAUDE.md・スキル・CIを更新するタスクが作られている
- [ ] 検証用に作ったリソースを削除した

## 参考
- Alchemy：https://alchemy.run/
- 記事：https://zenn.dev/caru/articles/96de2600acec67
- 今のTerraformの雛形：`infra/terraform/`
- この検証は人が主導する（ツール選定のため、実装LLMに任せきりにしない）
