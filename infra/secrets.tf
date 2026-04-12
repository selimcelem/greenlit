resource "aws_secretsmanager_secret" "anthropic" {
  name        = "${local.name_prefix}/anthropic-api-key"
  description = "Shared Anthropic API key used by the analyze Lambda"

  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "anthropic" {
  secret_id     = aws_secretsmanager_secret.anthropic.id
  secret_string = var.anthropic_api_key
}
