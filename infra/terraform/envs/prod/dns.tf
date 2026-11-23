# kokohima.app の DNS の記録（Terraform で持つもの。infra/README.md「DNS の例外」）
# カスタムドメイン（kokohima.app 本体）の記録は Workers が作るので、ここには書かない（T-12 決定事項6）

variable "zone_id" {
  type        = string
  description = "kokohima.app のゾーン ID（秘密ではないが、アカウントの ID と同じく実値はコミットしない）"
}

locals {
  # 送信のメール（Resend。docs/specs/T-07-notification.md、T-12「人が行う作業」4）
  # 値は Resend の管理画面（Domains → kokohima.app → Manual setup）に表示されたもの
  resend_records = {
    dkim = {
      name    = "resend._domainkey.kokohima.app"
      type    = "TXT"
      content = "\"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDxk61MhWnOlR/3DjCNHD/EpdOaqoW30O95zlwpB6Q1cTulKakJaMO9qFyT4/NzfgPM9TnHgw9mUvc+CSMdc9LMTvPrVeK6hdSotp954Owp28AiObRkBE6M7MTukxOsQ6/+BzduImy0cMylzkfkpqZ/FmA13/c4tbBAkkeP6EcmsQIDAQAB\""
    }
    send_spf_rsend = {
      name    = "rsend.kokohima.app"
      type    = "CNAME"
      content = "rsend-apne1.forge.rmta.net"
    }
    send_spf_send = {
      name    = "send.kokohima.app"
      type    = "CNAME"
      content = "send.forge.rmta.net"
    }
    # なりすましの監視から始める（p=none）。届き方を見て quarantine に上げる
    dmarc = {
      name    = "_dmarc.kokohima.app"
      type    = "TXT"
      content = "\"v=DMARC1; p=none;\""
    }
  }
}

resource "cloudflare_dns_record" "resend" {
  for_each = local.resend_records

  zone_id = var.zone_id
  name    = each.value.name
  type    = each.value.type
  content = each.value.content
  ttl     = 1 # 自動
  proxied = false
  comment = "Resend（送信のメール）。infra/terraform/envs/prod/dns.tf で管理"
}
