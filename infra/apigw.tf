resource "aws_apigatewayv2_api" "api" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  # Chrome extensions bypass CORS via host_permissions in manifest.json,
  # so API GW origin pinning adds no protection here. Access is gated by
  # the Cognito JWT authorizer on every route. S3 resume-bucket CORS still
  # pins var.allowed_origins because the browser talks directly to S3.
  cors_configuration {
    allow_origins  = ["*"]
    allow_methods  = ["GET", "POST", "PUT", "OPTIONS"]
    allow_headers  = ["Authorization", "Content-Type"]
    expose_headers = []
    max_age        = 300
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 20
  }
}

resource "aws_apigatewayv2_authorizer" "cognito" {
  api_id           = aws_apigatewayv2_api.api.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.extension.id]
    issuer   = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.main.id}"
  }
}

# ── integrations ────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_integration" "analyze" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.analyze.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "profile" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.profile.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "upload" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.upload.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "lemon_billing" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.lemon_billing.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_integration" "lemon_webhook" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.lemon_webhook.invoke_arn
  payload_format_version = "2.0"
}

# ── routes ──────────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_route" "analyze" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /analyze"
  target             = "integrations/${aws_apigatewayv2_integration.analyze.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "profile_get" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "GET /profile"
  target             = "integrations/${aws_apigatewayv2_integration.profile.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "profile_put" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "PUT /profile"
  target             = "integrations/${aws_apigatewayv2_integration.profile.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "upload" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /resume/upload"
  target             = "integrations/${aws_apigatewayv2_integration.upload.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "billing_checkout" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /billing/checkout-session"
  target             = "integrations/${aws_apigatewayv2_integration.lemon_billing.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

resource "aws_apigatewayv2_route" "billing_portal" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /billing/portal-session"
  target             = "integrations/${aws_apigatewayv2_integration.lemon_billing.id}"
  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.cognito.id
}

# Webhook is NOT behind the Cognito authorizer — Lemon Squeezy doesn't
# have a Cognito token. Authentication happens inside the Lambda via
# HMAC-SHA256 signature verification against the lemonsqueezy-webhook-secret.
# Route name stays provider-neutral so the LS dashboard webhook URL is
# stable if we ever add a second billing provider later.
resource "aws_apigatewayv2_route" "billing_webhook" {
  api_id             = aws_apigatewayv2_api.api.id
  route_key          = "POST /billing/webhook"
  target             = "integrations/${aws_apigatewayv2_integration.lemon_webhook.id}"
  authorization_type = "NONE"
}

# ── lambda permissions ──────────────────────────────────────────────────────

resource "aws_lambda_permission" "analyze" {
  statement_id  = "AllowAPIGwInvokeAnalyze"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.analyze.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "profile" {
  statement_id  = "AllowAPIGwInvokeProfile"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.profile.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "upload" {
  statement_id  = "AllowAPIGwInvokeUpload"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.upload.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "lemon_billing" {
  statement_id  = "AllowAPIGwInvokeLemonBilling"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lemon_billing.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

resource "aws_lambda_permission" "lemon_webhook" {
  statement_id  = "AllowAPIGwInvokeLemonWebhook"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.lemon_webhook.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
