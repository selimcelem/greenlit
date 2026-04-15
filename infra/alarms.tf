locals {
  # Destination for all CloudWatch alarm notifications. Subscribed to both
  # the primary (eu-central-1) and us-east-1 SNS topics below.
  alert_email = "selim.celem@gmail.com"
}

# ── SNS topics ──────────────────────────────────────────────────────────────
# Two topics because CloudWatch alarms can only publish to an SNS topic in
# the same region as the alarm, and the billing alarm must live in us-east-1.

resource "aws_sns_topic" "alerts" {
  name = "${local.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = local.alert_email
}

resource "aws_sns_topic" "alerts_us_east_1" {
  provider = aws.us_east_1
  name     = "${local.name_prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_us_east_1_email" {
  provider  = aws.us_east_1
  topic_arn = aws_sns_topic.alerts_us_east_1.arn
  protocol  = "email"
  endpoint  = local.alert_email
}

# ── Billing alarm ───────────────────────────────────────────────────────────
# AWS/Billing is a us-east-1-only namespace. Metric refreshes every ~6h, so
# the period and evaluation window are sized to that cadence rather than
# something tighter that would just sit in INSUFFICIENT_DATA.

resource "aws_cloudwatch_metric_alarm" "billing_monthly_estimated" {
  provider = aws.us_east_1

  alarm_name        = "${local.name_prefix}-billing-estimated-over-10usd"
  alarm_description = "Estimated AWS charges for the account exceeded $10 USD this billing cycle."

  namespace   = "AWS/Billing"
  metric_name = "EstimatedCharges"
  dimensions = {
    Currency = "USD"
  }

  statistic           = "Maximum"
  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  period              = 21600
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts_us_east_1.arn]
  ok_actions    = [aws_sns_topic.alerts_us_east_1.arn]
}

# ── Lambda daily invocation cap ─────────────────────────────────────────────
# Sums Invocations across every Greenlit function over a 24h window. Using
# SUM(METRICS()) so the expression auto-picks-up new functions when they
# get added to local.fn_name — no need to rewrite the expression.

resource "aws_cloudwatch_metric_alarm" "lambda_invocations_daily" {
  alarm_name        = "${local.name_prefix}-lambda-invocations-over-10k-daily"
  alarm_description = "Total Lambda invocations across all Greenlit functions exceeded 10,000 in a 24h window — possible abuse or runaway loop."

  comparison_operator = "GreaterThanThreshold"
  threshold           = 10000
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "total"
    expression  = "SUM(METRICS())"
    label       = "Total Greenlit invocations (24h)"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = { for idx, fn in values(local.fn_name) : "m${idx + 1}" => fn }
    content {
      id = metric_query.key
      metric {
        metric_name = "Invocations"
        namespace   = "AWS/Lambda"
        period      = 86400
        stat        = "Sum"
        dimensions = {
          FunctionName = metric_query.value
        }
      }
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ── Lambda per-function error rate ──────────────────────────────────────────
# One alarm per function. The IF guard on `invocations > 5` stops a single
# failure on a sleepy function (1/1 = 100%) from paging — we only care about
# error rate when there's enough traffic for the ratio to mean something.

resource "aws_cloudwatch_metric_alarm" "lambda_error_rate" {
  for_each = local.fn_name

  alarm_name        = "${each.value}-error-rate-over-10pct"
  alarm_description = "Error rate for ${each.value} exceeded 10% in a 5-minute window."

  comparison_operator = "GreaterThanThreshold"
  threshold           = 10
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "error_rate"
    expression  = "IF(invocations > 5, 100 * (errors / invocations), 0)"
    label       = "Error rate (%)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      metric_name = "Errors"
      namespace   = "AWS/Lambda"
      period      = 300
      stat        = "Sum"
      dimensions = {
        FunctionName = each.value
      }
    }
  }

  metric_query {
    id = "invocations"
    metric {
      metric_name = "Invocations"
      namespace   = "AWS/Lambda"
      period      = 300
      stat        = "Sum"
      dimensions = {
        FunctionName = each.value
      }
    }
  }

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
