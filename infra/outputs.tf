output "api_base_url" {
  description = "Base URL for the Greenlit API. Paste into extension/config.js."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "cognito_user_pool_id" {
  description = "Cognito User Pool ID"
  value       = aws_cognito_user_pool.main.id
}

output "cognito_app_client_id" {
  description = "Cognito App Client ID (extension)"
  value       = aws_cognito_user_pool_client.extension.id
}

output "cognito_region" {
  description = "Region the Cognito pool lives in"
  value       = var.region
}

output "resumes_bucket" {
  description = "S3 bucket for original resume PDFs"
  value       = aws_s3_bucket.resumes.bucket
}
