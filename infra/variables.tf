variable "region" {
  description = "AWS region for the entire stack"
  type        = string
  default     = "eu-central-1"
}

variable "project" {
  description = "Resource name prefix"
  type        = string
  default     = "greenlit"
}

variable "anthropic_api_key" {
  description = "Shared Anthropic API key the Lambdas use to call Claude"
  type        = string
  sensitive   = true
}

variable "lemonsqueezy_store_id" {
  description = "Lemon Squeezy store ID. Found in the LS dashboard under Store settings. Stays the same between test and live mode."
  type        = string
}

variable "lemonsqueezy_variant_id_starter" {
  description = "LS variant ID for the Greenlit Starter (€5/mo) product. Create the product manually in the LS dashboard and paste the variant ID here."
  type        = string
}

variable "lemonsqueezy_variant_id_pro" {
  description = "LS variant ID for the Greenlit Pro (€10/mo) product."
  type        = string
}

variable "lemonsqueezy_variant_id_max" {
  description = "LS variant ID for the Greenlit Max (€20/mo) product."
  type        = string
}

variable "allowed_origins" {
  description = "Origins allowed to call the API and PUT to the S3 resume bucket. Must be the chrome-extension://<id> origin once the extension is published. Wildcards are rejected."
  type        = list(string)
  default     = ["chrome-extension://REPLACE_WITH_REAL_EXTENSION_ID"]

  validation {
    condition     = length(var.allowed_origins) > 0 && !contains(var.allowed_origins, "*")
    error_message = "allowed_origins must be a non-empty list and may not contain '*'."
  }

  validation {
    condition     = alltrue([for o in var.allowed_origins : can(regex("^(chrome-extension|https)://", o))])
    error_message = "Each entry in allowed_origins must start with chrome-extension:// or https://."
  }
}
