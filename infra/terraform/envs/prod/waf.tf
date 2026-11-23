# 脆弱性スキャンのエッジでの遮断（docs/specs/T-26-wp-scan-block.md）
# WordPress・設定ファイル系の、このアプリが使わないパスを WAF のカスタムルールで遮断する（Worker に届く前に止める）
# パスの一覧は apps/api/src/http/waf-rule.test.ts が読んで、アプリの実在するパスに当たらないことを確かめる。
# 一覧の書き方（下の3つの locals）を変えるときは、そのテストも直す

locals {
  # パスの先頭が一致（大文字小文字は区別しない）
  scan_path_prefixes = [
    "/wp-admin",
    "/wp-login.php",
    "/wp-content",
    "/wp-includes",
    "/wp-json",
    "/.git",
    "/.aws",
    "/.vscode",
    "/phpinfo.php",
    "/phpmyadmin",
  ]
  # パスの全体が一致
  scan_path_exact = [
    "/xmlrpc.php",
  ]
  # パスの途中に含む（/api/.env、/stripe/.env など。/.env.save も含む）
  scan_path_contains = [
    "/.env",
  ]

  scan_expression = join(" or ", concat(
    [for p in local.scan_path_prefixes : "starts_with(lower(http.request.uri.path), \"${p}\")"],
    [for p in local.scan_path_exact : "lower(http.request.uri.path) eq \"${p}\""],
    [for p in local.scan_path_contains : "lower(http.request.uri.path) contains \"${p}\""],
  ))
}

# スキーマは Cloudflare 公式（developers.cloudflare.com/terraform/additional-configurations/waf-custom-rules/）の v5 の書き方に合わせた
resource "cloudflare_ruleset" "waf_custom" {
  zone_id     = var.zone_id
  name        = "kokohima.app WAF custom rules"
  description = "T-26：WordPress・設定ファイル系のスキャンを遮断する"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [{
    ref         = "block_vulnerability_scans"
    description = "WordPress・設定ファイル系のスキャンの遮断（T-26）"
    expression  = local.scan_expression
    action      = "block"
  }]
}
