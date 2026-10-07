terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      # v5系。導入時に最新の安定版へ固定し、更新はDependabotのPRで行う
      version = "~> 5.0"
    }
  }
}
