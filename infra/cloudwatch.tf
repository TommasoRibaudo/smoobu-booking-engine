##############################################################################
# cloudwatch.tf - Log groups, API Gateway access logging, alert topic, alarms,
#                 and an operations dashboard for the booking engine.
##############################################################################

locals {
  cloudwatch_log_retention_days = var.cloudwatch_log_retention_days != null ? var.cloudwatch_log_retention_days : (var.environment == "prod" ? 90 : 14)
  cloudwatch_alarm_actions      = var.cloudwatch_alarm_actions_enabled ? [aws_sns_topic.alerts.arn] : []
  booking_metric_namespace      = "BookingEngine/Api"
  booking_api_service_name      = "booking-api"

  lambda_alarm_functions = {
    booking_api            = aws_lambda_function.booking_api.function_name
    webhooks               = aws_lambda_function.webhooks.function_name
    hold_expiry            = aws_lambda_function.hold_expiry.function_name
    payment_reconciliation = aws_lambda_function.payment_reconciliation.function_name
  }

  booking_lambda_log_groups = {
    booking_api            = aws_cloudwatch_log_group.booking_api.name
    webhooks               = aws_cloudwatch_log_group.webhooks.name
    hold_expiry            = aws_cloudwatch_log_group.hold_expiry.name
    payment_reconciliation = aws_cloudwatch_log_group.payment_reconciliation.name
  }

  # The booking API emits named operational_alert logs now. These metric
  # filters create stable alarm metrics before the task 3.x route handlers add
  # the full provider/payment/state-machine behavior behind those signals.
  operational_alert_alarms = {
    booking_api_unhandled_error = {
      metric_name = "BookingApiUnhandledErrorAlertCount"
      threshold   = 1
      severity    = "critical"
    }
    paypal_webhook_rejected = {
      metric_name = "PaypalWebhookRejectedAlertCount"
      threshold   = 1
      severity    = "warning"
    }
    smoobu_webhook_auth_failure = {
      metric_name = "SmoobuWebhookAuthFailureAlertCount"
      threshold   = 3
      severity    = "warning"
    }
    public_rate_limit_triggered = {
      metric_name = "PublicRateLimitTriggeredAlertCount"
      threshold   = 20
      severity    = "warning"
    }
    captcha_escalation_triggered = {
      metric_name = "CaptchaEscalationTriggeredAlertCount"
      threshold   = 10
      severity    = "warning"
    }
    smoobu_provider_degraded = {
      metric_name = "SmoobuProviderDegradedAlertCount"
      threshold   = 1
      severity    = "warning"
    }
    booking_state_transition_failed = {
      metric_name = "BookingStateTransitionFailedAlertCount"
      threshold   = 1
      severity    = "critical"
    }
  }

  operational_alert_metric_filters = merge([
    for log_key, log_group_name in local.booking_lambda_log_groups : {
      for alert_name, config in local.operational_alert_alarms :
      "${log_key}-${alert_name}" => {
        log_group_name = log_group_name
        alert_name     = alert_name
        metric_name    = config.metric_name
      }
    }
  ]...)
}

##############################################################################
# Log groups
##############################################################################

resource "aws_cloudwatch_log_group" "api_gateway_access" {
  name              = "/aws/apigateway/${var.project}-${var.environment}-booking-api-access"
  retention_in_days = local.cloudwatch_log_retention_days

  tags = {
    Name = "${var.project}-${var.environment}-api-gateway-access-logs"
  }
}


##############################################################################
# API Gateway account role for execution/access logs
##############################################################################

data "aws_iam_policy_document" "api_gateway_cloudwatch_assume_role" {
  statement {
    sid     = "AllowAPIGatewayAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["apigateway.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api_gateway_cloudwatch" {
  name               = "${var.project}-${var.environment}-apigw-cloudwatch"
  description        = "Allows API Gateway to write booking API logs to CloudWatch."
  assume_role_policy = data.aws_iam_policy_document.api_gateway_cloudwatch_assume_role.json

  tags = {
    Name = "${var.project}-${var.environment}-apigw-cloudwatch-role"
  }
}

resource "aws_iam_role_policy_attachment" "api_gateway_cloudwatch" {
  role       = aws_iam_role.api_gateway_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "main" {
  # API Gateway account settings are regional singletons. If another Terraform
  # stack owns this in the same AWS account/region, import or centralize that
  # resource rather than applying two competing aws_api_gateway_account blocks.
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn

  depends_on = [aws_iam_role_policy_attachment.api_gateway_cloudwatch]
}

##############################################################################
# Alert delivery
##############################################################################

resource "aws_sns_topic" "alerts" {
  name = "${var.project}-${var.environment}-booking-alerts"

  tags = {
    Name = "${var.project}-${var.environment}-booking-alerts"
  }
}

resource "aws_sns_topic_subscription" "alert_email" {
  for_each = toset(var.cloudwatch_alert_email_addresses)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

##############################################################################
# Booking API custom observability alarms
##############################################################################

resource "aws_cloudwatch_log_metric_filter" "operational_alerts" {
  for_each = local.operational_alert_metric_filters

  name           = "${var.project}-${var.environment}-${each.key}"
  log_group_name = each.value.log_group_name
  pattern        = "{ $.eventType = \"operational_alert\" && $.alertName = \"${each.value.alert_name}\" }"

  metric_transformation {
    namespace = local.booking_metric_namespace
    name      = each.value.metric_name
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "operational_alerts" {
  for_each = local.operational_alert_alarms

  alarm_name          = "${var.project}-${var.environment}-${each.key}"
  alarm_description   = "Booking API emitted ${each.key} (${each.value.severity})."
  namespace           = local.booking_metric_namespace
  metric_name         = each.value.metric_name
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  tags = {
    Name = "${var.project}-${var.environment}-${each.key}"
  }
}

resource "aws_cloudwatch_metric_alarm" "smoobu_rate_limited" {
  alarm_name          = "${var.project}-${var.environment}-smoobu-rate-limited"
  alarm_description   = "Smoobu returned at least one 429 response."
  namespace           = local.booking_metric_namespace
  metric_name         = "SmoobuRateLimitedCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    Service     = local.booking_api_service_name
    Environment = var.environment
  }

  tags = {
    Name = "${var.project}-${var.environment}-smoobu-rate-limited"
  }
}

resource "aws_cloudwatch_metric_alarm" "abuse_rate_limited" {
  alarm_name          = "${var.project}-${var.environment}-public-rate-limit-spike"
  alarm_description   = "Public booking API rate limiting spiked."
  namespace           = local.booking_metric_namespace
  metric_name         = "RateLimitedCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    Service     = local.booking_api_service_name
    Environment = var.environment
  }

  tags = {
    Name = "${var.project}-${var.environment}-public-rate-limit-spike"
  }
}

resource "aws_cloudwatch_metric_alarm" "captcha_escalation" {
  alarm_name          = "${var.project}-${var.environment}-captcha-escalation-spike"
  alarm_description   = "CAPTCHA escalation responses spiked."
  namespace           = local.booking_metric_namespace
  metric_name         = "CaptchaRequiredCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    Service     = local.booking_api_service_name
    Environment = var.environment
  }

  tags = {
    Name = "${var.project}-${var.environment}-captcha-escalation-spike"
  }
}

resource "aws_cloudwatch_metric_alarm" "state_transition_failures" {
  alarm_name          = "${var.project}-${var.environment}-state-transition-failures"
  alarm_description   = "Booking state transition failures were emitted."
  namespace           = local.booking_metric_namespace
  metric_name         = "BookingStateTransitionFailureCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    Service     = local.booking_api_service_name
    Environment = var.environment
  }

  tags = {
    Name = "${var.project}-${var.environment}-state-transition-failures"
  }
}

##############################################################################
# Lambda and API Gateway alarms
##############################################################################

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each = local.lambda_alarm_functions

  alarm_name          = "${var.project}-${var.environment}-${each.key}-errors"
  alarm_description   = "Lambda ${each.value} reported one or more errors."
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    FunctionName = each.value
  }

  tags = {
    Name = "${var.project}-${var.environment}-${each.key}-errors"
  }
}

resource "aws_cloudwatch_metric_alarm" "lambda_throttles" {
  for_each = local.lambda_alarm_functions

  alarm_name          = "${var.project}-${var.environment}-${each.key}-throttles"
  alarm_description   = "Lambda ${each.value} was throttled."
  namespace           = "AWS/Lambda"
  metric_name         = "Throttles"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    FunctionName = each.value
  }

  tags = {
    Name = "${var.project}-${var.environment}-${each.key}-throttles"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_gateway_5xx" {
  alarm_name          = "${var.project}-${var.environment}-api-5xx"
  alarm_description   = "Booking API Gateway returned 5xx responses."
  namespace           = "AWS/ApiGateway"
  metric_name         = "5XXError"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    ApiName = aws_api_gateway_rest_api.main.name
    Stage   = aws_api_gateway_stage.main.stage_name
  }

  tags = {
    Name = "${var.project}-${var.environment}-api-5xx"
  }
}

resource "aws_cloudwatch_metric_alarm" "api_gateway_latency" {
  alarm_name          = "${var.project}-${var.environment}-api-latency"
  alarm_description   = "Booking API p95 latency exceeded the threshold."
  namespace           = "AWS/ApiGateway"
  metric_name         = "Latency"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 3000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  dimensions = {
    ApiName = aws_api_gateway_rest_api.main.name
    Stage   = aws_api_gateway_stage.main.stage_name
  }

  tags = {
    Name = "${var.project}-${var.environment}-api-latency"
  }
}

##############################################################################
# SES alarms
##############################################################################

resource "aws_cloudwatch_metric_alarm" "ses_bounce_rate" {
  alarm_name          = "${var.project}-${var.environment}-ses-bounce-rate"
  alarm_description   = "SES reputation bounce rate is elevated."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.BounceRate"
  statistic           = "Average"
  period              = 3600
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0.05
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  tags = {
    Name = "${var.project}-${var.environment}-ses-bounce-rate"
  }
}

resource "aws_cloudwatch_metric_alarm" "ses_complaint_rate" {
  alarm_name          = "${var.project}-${var.environment}-ses-complaint-rate"
  alarm_description   = "SES reputation complaint rate is elevated."
  namespace           = "AWS/SES"
  metric_name         = "Reputation.ComplaintRate"
  statistic           = "Average"
  period              = 3600
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 0.001
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.cloudwatch_alarm_actions
  ok_actions          = local.cloudwatch_alarm_actions

  tags = {
    Name = "${var.project}-${var.environment}-ses-complaint-rate"
  }
}

##############################################################################
# Dashboard
##############################################################################

resource "aws_cloudwatch_dashboard" "booking" {
  dashboard_name = "${var.project}-${var.environment}-booking"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API traffic by route and method"
          region = var.aws_region
          metrics = [
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route,Method} MetricName=\"RequestCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "request_count_by_route", "label" : "RequestCount" }]
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API latency p50/p95/p99"
          region = var.aws_region
          metrics = [
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"RequestLatencyMs\" Environment=\"${var.environment}\"', 'p50', 300)", "id" : "latency_p50", "label" : "p50" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"RequestLatencyMs\" Environment=\"${var.environment}\"', 'p95', 300)", "id" : "latency_p95", "label" : "p95" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"RequestLatencyMs\" Environment=\"${var.environment}\"', 'p99', 300)", "id" : "latency_p99", "label" : "p99" }]
          ]
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "API errors by route"
          region = var.aws_region
          metrics = [
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"ClientErrorCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "client_errors", "label" : "4xx" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"ServerErrorCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "server_errors", "label" : "5xx" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"ErrorCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "all_errors", "label" : "all errors" }]
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Abuse controls"
          region = var.aws_region
          metrics = [
            [local.booking_metric_namespace, "RateLimitedCount", "Service", local.booking_api_service_name, "Environment", var.environment, { "stat" : "Sum", "label" : "rate limited" }],
            [".", "CaptchaRequiredCount", ".", ".", ".", ".", { "stat" : "Sum", "label" : "captcha required" }]
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Webhook health"
          region = var.aws_region
          metrics = [
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"WebhookRejectedCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "webhook_rejected", "label" : "rejected" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Route} MetricName=\"UnauthorizedWebhookCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "webhook_unauthorized", "label" : "unauthorized" }]
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Provider health"
          region = var.aws_region
          metrics = [
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Provider,Operation} MetricName=\"ProviderRequestCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "provider_requests", "label" : "requests" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Provider,Operation} MetricName=\"ProviderErrorCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "provider_errors", "label" : "errors" }],
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,Provider,Operation} MetricName=\"ProviderLatencyMs\" Environment=\"${var.environment}\"', 'p95', 300)", "id" : "provider_latency", "label" : "latency p95" }],
            [local.booking_metric_namespace, "SmoobuRateLimitedCount", "Service", local.booking_api_service_name, "Environment", var.environment, { "stat" : "Sum", "label" : "Smoobu 429" }]
          ]
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Booking workflow"
          region = var.aws_region
          metrics = [
            [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,EntityType,Action,ToState} MetricName=\"BookingStateTransitionCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "state_transitions", "label" : "transitions" }],
            [local.booking_metric_namespace, "BookingStateTransitionFailureCount", "Service", local.booking_api_service_name, "Environment", var.environment, { "stat" : "Sum", "label" : "failures" }]
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 18
        width  = 12
        height = 6
        properties = {
          title  = "Operational alerts"
          region = var.aws_region
          metrics = concat(
            [
              [{ "expression" : "SEARCH('{${local.booking_metric_namespace},Service,Environment,AlertName,Route} MetricName=\"OperationalAlertCount\" Environment=\"${var.environment}\"', 'Sum', 300)", "id" : "emf_operational_alerts", "label" : "EMF OperationalAlertCount" }]
            ],
            [
              for alert_name, config in local.operational_alert_alarms :
              [local.booking_metric_namespace, config.metric_name, { "stat" : "Sum", "label" : alert_name }]
            ]
          )
          stat   = "Sum"
          period = 300
        }
      }
    ]
  })
}
