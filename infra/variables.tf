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
