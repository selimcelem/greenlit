locals {
  fn_name = {
    analyze       = "${local.name_prefix}-analyze"
    profile       = "${local.name_prefix}-profile"
    upload        = "${local.name_prefix}-upload"
    lemon_billing = "${local.name_prefix}-lemon-billing"
    lemon_webhook = "${local.name_prefix}-lemon-webhook"
  }
}

# ── log groups (declared up front so the Lambda role's least-privilege ──────
# logs policy can reference them, and so the Lambda doesn't need
# logs:CreateLogGroup at runtime).

resource "aws_cloudwatch_log_group" "analyze" {
  name              = "/aws/lambda/${local.fn_name.analyze}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "profile" {
  name              = "/aws/lambda/${local.fn_name.profile}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "upload" {
  name              = "/aws/lambda/${local.fn_name.upload}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "lemon_billing" {
  name              = "/aws/lambda/${local.fn_name.lemon_billing}"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "lemon_webhook" {
  name              = "/aws/lambda/${local.fn_name.lemon_webhook}"
  retention_in_days = 14
}

# ── analyze ─────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "analyze" {
  function_name = local.fn_name.analyze
  role          = aws_iam_role.analyze.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/analyze.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/analyze.zip")

  timeout     = 30
  memory_size = 512

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.analyze.name
  }

  environment {
    variables = {
      ANTHROPIC_SECRET_ARN = aws_secretsmanager_secret.anthropic.arn
      USERS_TABLE          = aws_dynamodb_table.users.name
      CACHE_TABLE          = aws_dynamodb_table.cache.name
    }
  }
}

# ── profile ─────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "profile" {
  function_name = local.fn_name.profile
  role          = aws_iam_role.profile.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/profile.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/profile.zip")

  timeout     = 10
  memory_size = 256

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.profile.name
  }

  environment {
    variables = {
      USERS_TABLE = aws_dynamodb_table.users.name
    }
  }
}

# ── upload ──────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "upload" {
  function_name = local.fn_name.upload
  role          = aws_iam_role.upload.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/upload.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/upload.zip")

  # pdf-parse does the work in-process and can be memory-bound on larger
  # PDFs. 512 MB / 30s leaves headroom for ~7 MB uploads without OOM.
  timeout     = 30
  memory_size = 512

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.upload.name
  }

  environment {
    variables = {
      RESUMES_BUCKET = aws_s3_bucket.resumes.bucket
      USERS_TABLE    = aws_dynamodb_table.users.name
    }
  }
}

# ── lemon-billing ───────────────────────────────────────────────────────────

resource "aws_lambda_function" "lemon_billing" {
  function_name = local.fn_name.lemon_billing
  role          = aws_iam_role.lemon_billing.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/lemon-billing.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/lemon-billing.zip")

  # Lemon Squeezy checkout + portal URL requests are a single API round-
  # trip each. 15s is generous headroom for DNS + TLS + LS API latency,
  # and gives us retries on the first (cold) Secrets Manager fetch.
  timeout     = 15
  memory_size = 256

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.lemon_billing.name
  }

  environment {
    variables = {
      USERS_TABLE              = aws_dynamodb_table.users.name
      LEMON_API_KEY_SECRET_ARN = aws_secretsmanager_secret.lemon_api_key.arn
      # Variant IDs come from tfvars — user creates the three products in
      # the LS dashboard manually, pastes the variant IDs into their
      # tfvars file, they flow through here to the Lambda runtime.
      LEMON_STORE_ID           = var.lemonsqueezy_store_id
      LEMON_VARIANT_ID_STARTER = var.lemonsqueezy_variant_id_starter
      LEMON_VARIANT_ID_PRO     = var.lemonsqueezy_variant_id_pro
      LEMON_VARIANT_ID_MAX     = var.lemonsqueezy_variant_id_max
    }
  }
}

# ── lemon-webhook ───────────────────────────────────────────────────────────

resource "aws_lambda_function" "lemon_webhook" {
  function_name = local.fn_name.lemon_webhook
  role          = aws_iam_role.lemon_webhook.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/lemon-webhook.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/lemon-webhook.zip")

  # Webhook handlers must respond within a few seconds or LS marks the
  # delivery failed and retries. We re-fetch the subscription on most
  # events so 15s covers a worst-case API roundtrip with retry headroom.
  timeout     = 15
  memory_size = 256

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.lemon_webhook.name
  }

  environment {
    variables = {
      USERS_TABLE              = aws_dynamodb_table.users.name
      LEMON_API_KEY_SECRET_ARN = aws_secretsmanager_secret.lemon_api_key.arn
      LEMON_WEBHOOK_SECRET_ARN = aws_secretsmanager_secret.lemon_webhook.arn
      # Same variant-ID env vars as the billing Lambda — the webhook uses
      # them to reverse-look-up the tier from a subscription's variant_id.
      LEMON_VARIANT_ID_STARTER = var.lemonsqueezy_variant_id_starter
      LEMON_VARIANT_ID_PRO     = var.lemonsqueezy_variant_id_pro
      LEMON_VARIANT_ID_MAX     = var.lemonsqueezy_variant_id_max
    }
  }
}
