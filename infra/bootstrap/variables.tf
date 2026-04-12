variable "region" {
  description = "Region to host the Terraform state bucket and lock table"
  type        = string
  default     = "eu-central-1"
}

variable "project" {
  description = "Resource name prefix"
  type        = string
  default     = "greenlit"
}
