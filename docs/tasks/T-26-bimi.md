# T-26 BIMI（通知メールに「ここ暇」のロゴを出す）

## 目的
通知メール（T-07・T-23）の差出人の横に、対応するメールアプリで「ここ暇」のロゴが出るようにする。BIMI は DMARC が `quarantine` 以上であることが前提なので、今の `p=none` を安全に上げるところから始める。

## 関係する要件
- 要求定義書「セキュリティ設計」（送信ドメインの SPF・DKIM・DMARC）、F-16（通知）
- T-07（メールの送信、Resend）、T-12（人が行う作業 4）、T-23（リッチなメール）
- `docs/specs/T-26-bimi.md`

## スコープ
- やること：
  - DMARC に `rua` を足し、レポートを見てから `quarantine` の `pct=100` へ段階的に上げる（`infra/terraform/envs/prod/dns.tf`）
  - BIMI 用のロゴ（SVG Tiny PS）を `apps/web/public/bimi/logo.svg` に置く
  - 証明書（VMC か CMC）を取り、`apps/web/public/bimi/vmc.pem` に置く（**人が行う**）
  - `default._bimi.kokohima.app` の TXT を `dns.tf` に足す
  - 単体テスト（ロゴの条件、記録とファイルの一致）
- やらないこと：アプリのアイコン・メール本文・差出人の変更、商標の出願、`terraform apply`（人が行う）

## 受け入れ条件
- [ ] 仕様書の確認事項1〜4が解消している（特に、証明書を取るか・どれを取るか）
- [ ] DMARC の記録が `rua` つきで、レポートで Resend 以外の失敗がないことを確かめてから `p=quarantine; pct=100` にしている
- [ ] `logo.svg` が SVG Tiny PS の条件（仕様書「テスト計画」）を満たし、`Content-Type: image/svg+xml` で認証なしに取れる
- [ ] `dns.tf` の BIMI の記録の URL が、置いたファイルと一致する。Terraform は `fmt`・`validate` を通し、`plan` の結果を PR に貼ってある。`apply` はしていない
- [ ] BIMI Group の Inspector で記録・ロゴ・証明書が通り、Gmail（または確認事項3の端末）でロゴが出ることを人が確かめた
- [ ] 実装PRに単体テストがある。API・D1 の変更はなく、「他人のIDでは取得できない」テストは対象外であることを仕様書に理由つきで書いてある
- [ ] 要求定義書の「送信ドメインのSPF・DKIM・DMARCの設定」と T-07 の該当の記述が、実装後の状態に直っている
