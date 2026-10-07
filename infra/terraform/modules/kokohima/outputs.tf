# wrangler の設定ファイルに転記するID
output "d1_database_id" {
  value = cloudflare_d1_database.main.id
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.cache.id
}

output "r2_bucket_name" {
  value = cloudflare_r2_bucket.ogp_images.name
}

output "queue_names" {
  value = {
    outbox = cloudflare_queue.outbox.queue_name
    dlq    = cloudflare_queue.outbox_dlq.queue_name
  }
}
