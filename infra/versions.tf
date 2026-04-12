terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Uncomment after creating the bootstrap S3 bucket + lock table.
  # backend "s3" {
  #   bucket         = "greenlit-tfstate"
  #   key            = "greenlit/terraform.tfstate"
  #   region         = "eu-central-1"
  #   dynamodb_table = "greenlit-tfstate-lock"
  #   encrypt        = true
  # }
}
