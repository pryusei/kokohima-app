# インフラ（IaC）

> 暫定でTerraformの雛形を置いています。AlchemyとのIaCツールの比較検証（`docs/tasks/T-00-iac-spike.md`）の結果で確定します。

| 管理するもの | 方法 |
| --- | --- |
| D1・KV・R2・Queues、DNS、WAF、レート制限、Access、通知 | Terraform（`infra/terraform`） |
| Workersのコード、バインディング、Cron、環境ごとの設定 | wranglerの設定ファイル（`apps/api`） |
| 秘密情報 | `wrangler secret` のみ。Terraformにもwranglerの設定にも書かない |

## ルール
- 管理画面で手動変更しない。変更は必ずPRで行う
  - 例外：通知の設定（Monitors・Workers Issues の自動の通知・通知先の webhook）は管理画面で人が行う。設定の内容は docs/runbooks/monitoring.md を正とし、変えるときは先にその手順書を直す PR を出す（docs/specs/T-13-monitoring.md「6.」）
- `terraform apply` は人が実行する（CIは plan まで）。Claudeには実行させない
- D1は `prevent_destroy` で守っている。置き換えが必要な変更は、バックアップと移行手順を仕様書に書いてから
- プロバイダはバージョンを固定し、更新はDependabotのPRで差分を確認してから

## 初回の手順
1. Cloudflareで状態ファイル用のR2バケット `kokohima-tfstate` を手動で作る（唯一の手動作業）
2. 用途を絞ったAPIトークンを作り、`CLOUDFLARE_API_TOKEN` に設定する（アカウントの D1・Workers KV Storage・Workers R2 Storage・Queues と、`kokohima.app` のゾーンの DNS。CI の plan 用は同じ範囲の読み取りだけ）
3. `cd infra/terraform/envs/prod`（最初のリリースは prod だけ。docs/specs/T-12-release.md）
4. `terraform init -backend-config="endpoints={s3=\"https://<ACCOUNT_ID>.r2.cloudflarestorage.com\"}"`
5. `terraform plan -var account_id=<ACCOUNT_ID> -var zone_id=<ZONE_ID>` で確認してから `apply`（`zone_id` は `kokohima.app` のゾーン ID。prod の DNS の記録で使う）
6. 出力されたIDを `apps/api` のwrangler設定の該当環境に転記する

## 環境
- `staging`：本番と同じ構成の確認用（最初のリリースでは作らない。T-12 決定事項5）
- `prod`：本番（`https://kokohima.app`）
- E2Eはローカル（wrangler dev）で動かすため、Terraformのリソースは使わない

## デプロイ（prod。人が行う。docs/specs/T-12-release.md「人が行う作業」）
- `pnpm --filter api db:migrate:prod`：D1 のマイグレーションを本番に適用する
- `pnpm --filter api deploy:prod`：画面をビルドし、画面のビルドと wrangler の設定を検査してから `wrangler deploy --env prod`
- 問題があれば `wrangler rollback --env prod` で戻す

## DNS の例外
- `kokohima.app` のカスタムドメインの記録は、Workers（`custom_domain: true`）が作り、管理する。Terraform の DNS の管理の例外（T-12 決定事項6）。
- ほかの DNS の記録（Resend の SPF・DKIM、DMARC など）は Terraform で持つ（`infra/terraform/envs/prod/dns.tf`）。
- CI の plan は、GitHub の秘密 `CLOUDFLARE_ZONE_ID` を `TF_VAR_zone_id` として渡す。
