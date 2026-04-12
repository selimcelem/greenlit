output "state_bucket" {
  description = "S3 bucket for the main stack's terraform state"
  value       = aws_s3_bucket.tfstate.bucket
}

output "lock_table" {
  description = "DynamoDB table for terraform state locking"
  value       = aws_dynamodb_table.tfstate_lock.name
}

output "backend_hcl" {
  description = "Save this to infra/backend.hcl, then run `terraform init -backend-config=backend.hcl` in /infra."
  value       = <<-EOT
    bucket         = "${aws_s3_bucket.tfstate.bucket}"
    key            = "greenlit/terraform.tfstate"
    region         = "${var.region}"
    dynamodb_table = "${aws_dynamodb_table.tfstate_lock.name}"
    encrypt        = true
  EOT
}
