terraform {
  # 状態ファイルはR2（S3互換）に保存する。バケットは最初に手動で1つだけ作る
  backend "s3" {
    bucket                      = "kokohima-tfstate"
    key                         = "prod/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
    # endpoints は init 時に -backend-config で渡す（アカウントIDを含むため）
  }
}

# APIトークンは環境変数 CLOUDFLARE_API_TOKEN で渡す。ファイルに書かない
provider "cloudflare" {}

variable "account_id" {
  type = string
}

module "kokohima" {
  source     = "../../modules/kokohima"
  account_id = var.account_id
  env        = "prod"
}

output "resources" {
  value = module.kokohima
}
