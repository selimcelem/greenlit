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
