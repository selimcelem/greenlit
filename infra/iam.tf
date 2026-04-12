data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# ── analyze ─────────────────────────────────────────────────────────────────

resource "aws_iam_role" "analyze" {
  name               = "${local.name_prefix}-analyze"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "analyze_inline" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.analyze.arn}:*"]
  }

  statement {
    sid    = "DynamoAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = [
      aws_dynamodb_table.users.arn,
      aws_dynamodb_table.cache.arn,
    ]
  }

  statement {
    sid       = "ReadAnthropicSecret"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.anthropic.arn]
  }
}

resource "aws_iam_role_policy" "analyze_inline" {
  role   = aws_iam_role.analyze.id
  policy = data.aws_iam_policy_document.analyze_inline.json
}

# ── profile ─────────────────────────────────────────────────────────────────

resource "aws_iam_role" "profile" {
  name               = "${local.name_prefix}-profile"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "profile_inline" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.profile.arn}:*"]
  }

  statement {
    sid    = "DynamoAccess"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
    ]
    resources = [aws_dynamodb_table.users.arn]
  }
}

resource "aws_iam_role_policy" "profile_inline" {
  role   = aws_iam_role.profile.id
  policy = data.aws_iam_policy_document.profile_inline.json
}

# ── upload ──────────────────────────────────────────────────────────────────

resource "aws_iam_role" "upload" {
  name               = "${local.name_prefix}-upload"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "upload_inline" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.upload.arn}:*"]
  }

  statement {
    sid       = "PutResumePdf"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.resumes.arn}/resumes/*"]
  }
}

resource "aws_iam_role_policy" "upload_inline" {
  role   = aws_iam_role.upload.id
  policy = data.aws_iam_policy_document.upload_inline.json
}
