# T-26 脆弱性スキャンのエッジでの遮断（WAFのカスタムルール）

## 目的
`kokohima.app` はWordPressではないが、`/wp-admin/install.php`・`/wp-login.php`・`/.env`・`/.git/config` などへのスキャンが届き、そのたびにWorkerが起動して静的アセットを引いている。Workerより手前（Cloudflare WAF）で止め、Workersの実行とログのノイズを減らす。

## 関係する要件
- 要求定義書「AI時代の攻撃を前提にした運用」、NF-02
- T-12（振り分け・セキュリティのヘッダー）、T-13（監視）

## スコープ
- やること：`infra/terraform` に、WordPress系・設定ファイル系の固定パスを遮断するWAFのカスタムルールを足す
- やらないこと：Workerのコードの変更、レート制限・Bot対策の新設、IPやUAでの遮断

## 受け入れ条件
- [ ] ルールがTerraformで管理され、`terraform fmt`・`validate` が通り、`plan` の結果がPRに貼ってある
- [ ] 正当な画面・APIのパス（`/`、`/api/`、`/assets/` など）に当たらない
- [ ] apply は人が行う
