# ここ暇のCloudflareリソース（環境ごとに1セット）
# Workersのコードとバインディングは wrangler で管理し、ここではリソース本体を作る

resource "cloudflare_d1_database" "main" {
  account_id = var.account_id
  name       = "kokohima-${var.env}"

  # D1は置き換えるとデータが消えるため、削除・置き換えを禁止する
  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_kv_namespace" "cache" {
  account_id = var.account_id
  title      = "kokohima-${var.env}-cache"
}

resource "cloudflare_r2_bucket" "ogp_images" {
  account_id = var.account_id
  name       = "kokohima-${var.env}-ogp-images"
}

resource "cloudflare_queue" "outbox" {
  account_id = var.account_id
  queue_name = "kokohima-${var.env}-outbox"
}

resource "cloudflare_queue" "outbox_dlq" {
  account_id = var.account_id
  queue_name = "kokohima-${var.env}-outbox-dlq"
}

# 次のPRで追加する（スキーマを公式ドキュメントで確認してから）：
# - DNS（cloudflare_dns_record）
# - WAFのマネージドルールとレート制限（cloudflare_ruleset）
# - 運営機能の保護（Cloudflare Access）
# - 利用料・異常の通知
