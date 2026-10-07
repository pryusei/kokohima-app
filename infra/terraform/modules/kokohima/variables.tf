variable "account_id" {
  type        = string
  description = "CloudflareのアカウントID"
}

variable "env" {
  type        = string
  description = "環境名（staging / prod）"
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env は staging か prod にしてください。"
  }
}
