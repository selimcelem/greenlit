provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project   = "greenlit"
      ManagedBy = "terraform"
    }
  }
}

# AWS/Billing metrics are only published in us-east-1, so the billing alarm
# in alarms.tf has to be created against this aliased provider regardless
# of the primary region.
#
# No default_tags on purpose: the deploy role is missing ListTagsForResource
# on CloudWatch alarms / SNS topics in us-east-1, and with default_tags set
# the AWS provider reads tags on every refresh and fails the apply. The
# us-east-1 footprint is just the billing alarm plus its SNS topic, so
# losing the Project/ManagedBy tags on those two resources is acceptable.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
