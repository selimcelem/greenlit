locals {
  fn_name = {
    analyze = "${local.name_prefix}-analyze"
    profile = "${local.name_prefix}-profile"
    upload  = "${local.name_prefix}-upload"
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
