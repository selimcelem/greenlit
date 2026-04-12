provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "greenlit"
      ManagedBy = "terraform"
    }
  }
}
