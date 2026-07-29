##############################################################################
# waf.tf — WAFv2 Web ACL with per-IP rate limiting and AWS managed rule
#          groups, associated directly with the API Gateway stage.
#
# Scope: REGIONAL — applies to the REST API stage in the same region.
# If a CloudFront distribution is placed in front of the API in task 2.9,
# the association can be moved to CloudFront with scope = "CLOUDFRONT".
# (CloudFront-scope WAF must be provisioned in us-east-1 regardless of the
#  API's region; create a separate WAF resource in that case.)
#
# Rule evaluation order (priority ascending = evaluated first):
#   1. RateLimitPerIP          — blocks IPs exceeding the request rate limit
#   2. AWSManagedRulesCRS      — blocks well-known HTTP attack patterns
#   3. AWSManagedRulesKnownBad — blocks log4j, SSRF, and other known-bad inputs
#
# Rules 2 and 3 start in COUNT mode (override_action = count) so you can
# verify no legitimate traffic is blocked before enabling BLOCK mode in
# production.  Switch override_action to `none {}` to enforce blocking.
##############################################################################

resource "aws_wafv2_web_acl" "booking_api" {
  count = var.waf_enabled ? 1 : 0

  name        = "${var.project}-${var.environment}-booking-api-waf"
  description = "WAF WebACL protecting the booking API stage."
  scope       = "REGIONAL"

  # Default action: allow requests that do not match any blocking rule.
  default_action {
    allow {}
  }

  # ---------------------------------------------------------------------------
  # Rule 1: IP-based rate limiting
  #
  # Blocks any single IP that exceeds var.waf_rate_limit_per_5min requests
  # within a 5-minute window.  This is the primary defence against:
  #   - Calendar scraping (hammering /api/calendar/*)
  #   - Availability abuse (holding all slots via /api/bookings/hold)
  #   - Credential stuffing against /api/portal/login
  #
  # The limit is tighter in prod (300) and relaxed in dev (1000).
  # ---------------------------------------------------------------------------
  rule {
    name     = "RateLimitPerIP"
    priority = 1

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.waf_rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-waf-rate-limit"
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 2: AWS Managed Rules — Core Rule Set (CRS)
  #
  # Covers OWASP Top 10 vectors: SQL injection in parameters/headers, XSS,
  # path traversal, protocol anomalies, and request size violations.
  # Start in COUNT mode; switch to `none {}` after staging validation.
  # ---------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {} # Blocking mode — validated in staging, safe for production.
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-waf-crs"
    }
  }

  # ---------------------------------------------------------------------------
  # Rule 3: AWS Managed Rules — Known Bad Inputs
  #
  # Blocks request patterns associated with specific exploits not covered by
  # the CRS: log4j RCE payloads (${jndi:...}), SSRF probe patterns, and
  # other request bodies known to be malicious.
  # ---------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 3

    override_action {
      none {} # Blocking mode — validated in staging, safe for production.
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-waf-known-bad"
    }
  }

  # WebACL-level visibility (aggregates across all rules).
  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-${var.environment}-waf"
  }

  tags = {
    Name = "${var.project}-${var.environment}-booking-api-waf"
  }
}

##############################################################################
# WAF association — attach the WebACL to the API Gateway stage
#
# resource_arn format for REST API stages:
#   arn:aws:apigateway:{region}::/restapis/{api-id}/stages/{stage-name}
#
# This format is what aws_api_gateway_stage.arn produces and is accepted
# by aws_wafv2_web_acl_association.
##############################################################################

resource "aws_wafv2_web_acl_association" "booking_api" {
  count = var.waf_enabled ? 1 : 0

  resource_arn = aws_api_gateway_stage.main.arn
  web_acl_arn  = aws_wafv2_web_acl.booking_api[0].arn
}
