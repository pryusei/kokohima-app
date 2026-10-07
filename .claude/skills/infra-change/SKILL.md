---
name: infra-change
description: infra/terraform やwranglerの設定（Cloudflareのリソース、DNS、WAF、レート制限、Access）を変更するときの手順
---
# インフラの変更

1. 変更は仕様書PRで内容を合意してから、実装PRで行う（アプリと同じ流れ）
2. Terraformのリソースのスキーマは、Cloudflareプロバイダv5の公式ドキュメントで確認してから書く。記憶で書かない
3. `terraform fmt` と `terraform validate` を実行する。`plan` の結果をPRに貼る
4. `terraform apply`・`destroy` と `wrangler deploy` は実行しない（人が行う）
5. D1の置き換え・削除につながる差分が出たら止めて報告する
6. 秘密情報・アカウントIDの実値をコミットしない
