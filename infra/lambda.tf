# ── analyze ─────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "analyze" {
  function_name = "${local.name_prefix}-analyze"
  role          = aws_iam_role.analyze.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/analyze.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/analyze.zip")

  timeout     = 30
  memory_size = 512

  environment {
    variables = {
      ANTHROPIC_SECRET_ARN = aws_secretsmanager_secret.anthropic.arn
      USERS_TABLE          = aws_dynamodb_table.users.name
      CACHE_TABLE          = aws_dynamodb_table.cache.name
    }
  }
}

resource "aws_cloudwatch_log_group" "analyze" {
  name              = "/aws/lambda/${aws_lambda_function.analyze.function_name}"
  retention_in_days = 14
}

# ── profile ─────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "profile" {
  function_name = "${local.name_prefix}-profile"
  role          = aws_iam_role.profile.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/profile.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/profile.zip")

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      USERS_TABLE = aws_dynamodb_table.users.name
    }
  }
}

resource "aws_cloudwatch_log_group" "profile" {
  name              = "/aws/lambda/${aws_lambda_function.profile.function_name}"
  retention_in_days = 14
}

# ── upload ──────────────────────────────────────────────────────────────────

resource "aws_lambda_function" "upload" {
  function_name = "${local.name_prefix}-upload"
  role          = aws_iam_role.upload.arn
  runtime       = "nodejs20.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  filename         = "${local.backend_dist}/upload.zip"
  source_code_hash = filebase64sha256("${local.backend_dist}/upload.zip")

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      RESUMES_BUCKET = aws_s3_bucket.resumes.bucket
    }
  }
}

resource "aws_cloudwatch_log_group" "upload" {
  name              = "/aws/lambda/${aws_lambda_function.upload.function_name}"
  retention_in_days = 14
}
