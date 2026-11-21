# インフラ（IaC）

> 暫定でTerraformの雛形を置いています。AlchemyとのIaCツールの比較検証（`docs/tasks/T-00-iac-spike.md`）の結果で確定します。

| 管理するもの | 方法 |
| --- | --- |
| D1・KV・R2・Queues、DNS、WAF、レート制限、Access、通知 | Terraform（`infra/terraform`） |
| Workersのコード、バインディング、Cron、環境ごとの設定 | wranglerの設定ファイル（`apps/api`） |
| 秘密情報 | `wrangler secret` のみ。Terraformにもwranglerの設定にも書かない |

## ルール
- 管理画面で手動変更しない。変更は必ずPRで行う
- `terraform apply` は人が実行する（CIは plan まで）。Claudeには実行させない
- D1は `prevent_destroy` で守っている。置き換えが必要な変更は、バックアップと移行手順を仕様書に書いてから
- プロバイダはバージョンを固定し、更新はDependabotのPRで差分を確認してから

## 初回の手順
1. Cloudflareで状態ファイル用のR2バケット `kokohima-tfstate` を手動で作る（唯一の手動作業）
2. 用途を絞ったAPIトークンを作り、`CLOUDFLARE_API_TOKEN` に設定する
3. `cd infra/terraform/envs/staging`
4. `terraform init -backend-config="endpoints={s3=\"https://<ACCOUNT_ID>.r2.cloudflarestorage.com\"}"`
5. `terraform plan -var account_id=<ACCOUNT_ID>` で確認してから `apply`
6. 出力されたIDを `apps/api` のwrangler設定の該当環境に転記する

## 環境
- `staging`：本番と同じ構成の確認用
- `prod`：本番
- E2Eはローカル（wrangler dev）で動かすため、Terraformのリソースは使わない
