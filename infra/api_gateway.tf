##############################################################################
# api_gateway.tf — REST API, resource hierarchy, Lambda proxy integrations,
#                  CORS gateway responses, stage, and throttling settings.
#
# Design choices:
#   - REST API (v1) rather than HTTP API (v2): REST API supports direct WAF
#     WebACL association via aws_wafv2_web_acl_association (see waf.tf).
#   - Lambda proxy integration (AWS_PROXY): API Gateway forwards the raw
#     HTTP request to Lambda and returns the Lambda response verbatim.
#     CORS headers are the Lambda's responsibility; gateway responses below
#     add CORS headers to non-Lambda errors (throttling, auth failures, etc.).
#   - Webhook routes use a dedicated webhooks Lambda, isolated from the main
#     booking_api Lambda (separate blast radius, independent deployability).
#   - The /api/{proxy+} greedy catch-all routes all other booking API paths
#     to the booking_api Lambda. API Gateway resolves more-specific paths
#     (e.g. /api/webhooks/smoobu) before the greedy proxy.
##############################################################################

##############################################################################
# REST API
##############################################################################

resource "aws_api_gateway_rest_api" "main" {
  name        = "${var.project}-${var.environment}-api"
  description = "Booking engine REST API."

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = {
    Name = "${var.project}-${var.environment}-api"
  }
}

##############################################################################
# Resource hierarchy
#
#   /api
#     /webhooks
#       /smoobu          POST → webhooks Lambda
#       /paypal          POST → webhooks Lambda
#     /{proxy+}          ANY  → booking_api Lambda  (catches all other routes)
##############################################################################

resource "aws_api_gateway_resource" "api" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_rest_api.main.root_resource_id
  path_part   = "api"
}

resource "aws_api_gateway_resource" "webhooks" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "webhooks"
}

resource "aws_api_gateway_resource" "webhooks_smoobu" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.webhooks.id
  path_part   = "smoobu"
}

resource "aws_api_gateway_resource" "webhooks_paypal" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.webhooks.id
  path_part   = "paypal"
}

# Greedy proxy — catches: /api/availability/quote, /api/calendar/{slug},
# /api/bookings/*, /api/deposit-handoff, /api/portal/*.
resource "aws_api_gateway_resource" "api_proxy" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  parent_id   = aws_api_gateway_resource.api.id
  path_part   = "{proxy+}"
}

##############################################################################
# POST /api/webhooks/smoobu → webhooks Lambda
##############################################################################

resource "aws_api_gateway_method" "webhooks_smoobu_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.webhooks_smoobu.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "webhooks_smoobu" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.webhooks_smoobu.id
  http_method             = aws_api_gateway_method.webhooks_smoobu_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.webhooks.invoke_arn
}

##############################################################################
# POST /api/webhooks/paypal → webhooks Lambda
##############################################################################

resource "aws_api_gateway_method" "webhooks_paypal_post" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.webhooks_paypal.id
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "webhooks_paypal" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.webhooks_paypal.id
  http_method             = aws_api_gateway_method.webhooks_paypal_post.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.webhooks.invoke_arn
}

##############################################################################
# ANY /api/{proxy+} → booking_api Lambda
#
# Handles all booking API routes including OPTIONS preflight (the Lambda
# returns appropriate CORS headers for all methods).
#
# Routes covered:
#   POST   /api/availability/quote
#   GET    /api/calendar/{apartmentSlug}
#   POST   /api/bookings/hold
#   POST   /api/bookings/{booking_id}/paypal/create-order
#   POST   /api/bookings/{booking_id}/paypal/capture
#   GET    /api/deposit-handoff
#   POST   /api/portal/login
#   GET    /api/portal/bookings/{reservation_public_id}
##############################################################################

resource "aws_api_gateway_method" "api_proxy_any" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  resource_id   = aws_api_gateway_resource.api_proxy.id
  http_method   = "ANY"
  authorization = "NONE"

  request_parameters = {
    "method.request.path.proxy" = true
  }
}

resource "aws_api_gateway_integration" "api_proxy" {
  rest_api_id             = aws_api_gateway_rest_api.main.id
  resource_id             = aws_api_gateway_resource.api_proxy.id
  http_method             = aws_api_gateway_method.api_proxy_any.http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.booking_api.invoke_arn

  request_parameters = {
    "integration.request.path.proxy" = "method.request.path.proxy"
  }
}

##############################################################################
# CORS — gateway responses
#
# API Gateway gateway responses fire for errors that never reach Lambda:
# throttling (429), auth failures (401/403), missing route (404 MISSING), etc.
# Without CORS headers on these responses, the browser cannot read the error
# body and will report a generic "Network Error" instead.
#
# Lambda-originated responses carry CORS headers set inside the function.
##############################################################################

locals {
  # CORS origin for gateway-level error responses (4xx/5xx/throttled that
  # never reach Lambda).  Uses the first origin from the allowed list so
  # gateway errors are readable by the browser.  Falls back to the prod
  # domain if the variable is empty during initial bootstrap.
  gateway_cors_origin = coalesce(
    try(split(",", var.booking_api_allowed_origins)[0], ""),
    "https://example.com"
  )
}

resource "aws_api_gateway_gateway_response" "cors_default_4xx" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  response_type = "DEFAULT_4XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${local.gateway_cors_origin}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'GET,POST,OPTIONS'"
  }
}

resource "aws_api_gateway_gateway_response" "cors_default_5xx" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  response_type = "DEFAULT_5XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${local.gateway_cors_origin}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'GET,POST,OPTIONS'"
  }
}

# Explicit CORS header for throttling responses (WAF/stage-level 429s).
resource "aws_api_gateway_gateway_response" "cors_throttled" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  response_type = "THROTTLED"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${local.gateway_cors_origin}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token'"
    "gatewayresponse.header.Access-Control-Allow-Methods" = "'GET,POST,OPTIONS'"
  }
}

##############################################################################
# Deployment
#
# The triggers hash captures IDs of all methods and integrations.  Any
# change to the API model forces a new deployment, which Terraform applies
# before updating the stage (create_before_destroy).
##############################################################################

resource "aws_api_gateway_deployment" "main" {
  rest_api_id = aws_api_gateway_rest_api.main.id

  triggers = {
    redeployment = sha256(jsonencode([
      aws_api_gateway_resource.api.id,
      aws_api_gateway_resource.webhooks.id,
      aws_api_gateway_resource.webhooks_smoobu.id,
      aws_api_gateway_resource.webhooks_paypal.id,
      aws_api_gateway_resource.api_proxy.id,
      aws_api_gateway_method.webhooks_smoobu_post.id,
      aws_api_gateway_integration.webhooks_smoobu.id,
      aws_api_gateway_method.webhooks_paypal_post.id,
      aws_api_gateway_integration.webhooks_paypal.id,
      aws_api_gateway_method.api_proxy_any.id,
      aws_api_gateway_integration.api_proxy.id,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.webhooks_smoobu_post,
    aws_api_gateway_integration.webhooks_smoobu,
    aws_api_gateway_method.webhooks_paypal_post,
    aws_api_gateway_integration.webhooks_paypal,
    aws_api_gateway_method.api_proxy_any,
    aws_api_gateway_integration.api_proxy,
  ]
}

##############################################################################
# Stage
##############################################################################

resource "aws_api_gateway_stage" "main" {
  rest_api_id   = aws_api_gateway_rest_api.main.id
  deployment_id = aws_api_gateway_deployment.main.id
  stage_name    = var.environment

  # X-Ray distributed tracing — samples ~5% of requests by default.
  # Combine with Lambda X-Ray active tracing (configurable in future tasks)
  # for end-to-end trace visibility.
  xray_tracing_enabled = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway_access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      requestTime    = "$context.requestTime"
      httpMethod     = "$context.httpMethod"
      routeKey       = "$context.resourcePath"
      status         = "$context.status"
      protocol       = "$context.protocol"
      responseLength = "$context.responseLength"
      errorMessage   = "$context.error.message"
    })
  }

  depends_on = [
    aws_api_gateway_deployment.main,
    aws_api_gateway_account.main,
  ]

  tags = {
    Name = "${var.project}-${var.environment}-api-stage"
  }
}

##############################################################################
# Stage-level throttling
#
# Applied to all routes via the "*/*" wildcard.  WAF rate-limiting (waf.tf)
# is the primary per-IP control; stage throttling is a secondary safeguard
# against Lambda concurrency exhaustion from any single client.
#
# burst_limit: token-bucket capacity (max instantaneous requests)
# rate_limit:  steady-state requests per second (token refill rate)
##############################################################################

resource "aws_api_gateway_method_settings" "throttle" {
  rest_api_id = aws_api_gateway_rest_api.main.id
  stage_name  = aws_api_gateway_stage.main.stage_name
  method_path = "*/*"

  settings {
    throttling_burst_limit = 100
    throttling_rate_limit  = 50

    # Enable CloudWatch metrics for every method (latency, 4xx, 5xx counts).
    metrics_enabled = true

    # ERROR-level logging records only failed requests.  Switch to INFO
    # temporarily when debugging a specific route.
    logging_level = "ERROR"

    # Full request/response logging is disabled by default — it can expose
    # PII in logs.  Enable only with explicit consent/need.
    data_trace_enabled = false
  }
}
