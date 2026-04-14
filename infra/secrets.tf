resource "aws_secretsmanager_secret" "anthropic" {
  name        = "${local.name_prefix}/anthropic-api-key"
  description = "Shared Anthropic API key used by the analyze Lambda"

  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "anthropic" {
  secret_id     = aws_secretsmanager_secret.anthropic.id
  secret_string = var.anthropic_api_key
}

# ── Lemon Squeezy secrets ───────────────────────────────────────────────────
#
# The API key and webhook signing secret live in separate Secret ARNs so the
# billing Lambda and webhook Lambda can each be granted exactly the keys they
# need. Values are NOT managed by Terraform — after the first apply, populate
# them manually via the AWS console or CLI:
#
#   aws secretsmanager put-secret-value \
#     --secret-id greenlit/lemonsqueezy-api-key \
#     --region eu-central-1 \
#     --secret-string 'your_api_key_from_dashboard'
#
# The `lifecycle { ignore_changes = [secret_string] }` on the version
# resources means subsequent applies won't overwrite whatever value you
# stored. Starting value is a placeholder that will make the Lambdas fail
# loudly until you swap it — intentional, so you can't accidentally ship a
# stack that silently talks to nothing.

resource "aws_secretsmanager_secret" "lemon_api_key" {
  name        = "${local.name_prefix}/lemonsqueezy-api-key"
  description = "Lemon Squeezy API key used by billing and webhook Lambdas"

  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "lemon_api_key" {
  secret_id     = aws_secretsmanager_secret.lemon_api_key.id
  secret_string = "REPLACE_ME_AFTER_APPLY_lemon_api_key"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "lemon_webhook" {
  name        = "${local.name_prefix}/lemonsqueezy-webhook-secret"
  description = "Lemon Squeezy webhook signing secret used by the webhook Lambda to verify HMAC-SHA256 signatures"

  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "lemon_webhook" {
  secret_id     = aws_secretsmanager_secret.lemon_webhook.id
  secret_string = "REPLACE_ME_AFTER_APPLY_lemon_webhook_secret"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
