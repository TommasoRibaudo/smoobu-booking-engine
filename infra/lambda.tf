##############################################################################
# lambda.tf — IAM execution role, placeholder code archives, and Lambda
#             function definitions for the booking API.
#
# Two Lambda functions:
#   booking_api  — handles all booking flows (availability, holds, PayPal
#                  orders/captures, deposit handoff, portal). Runs in VPC
#                  private subnets for direct access to RDS.
#   webhooks     — receives Smoobu and PayPal webhook events. Isolated from
#                  the booking flow so misbehaving webhook processing cannot
#                  affect the main booking path.
#
# Both functions use placeholder handlers here; real business logic is
# deployed via CI/CD (`aws lambda update-function-code`) in task 3.x
# without modifying this Terraform file.
##############################################################################

##############################################################################
# Data sources
##############################################################################

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

##############################################################################
# IAM — Lambda execution role
##############################################################################

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    sid     = "AllowLambdaAssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.project}-${var.environment}-lambda-exec"
  description        = "Execution role shared by booking API Lambda functions."
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json

  tags = {
    Name = "${var.project}-${var.environment}-lambda-exec-role"
  }
}

# Write logs to CloudWatch Logs.
resource "aws_iam_role_policy_attachment" "lambda_basic_execution" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Create/describe/delete ENIs — required for VPC-attached Lambda functions.
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Attach the DB secret read policy created in database.tf.
resource "aws_iam_role_policy_attachment" "lambda_db_secret_read" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.db_secret_read.arn
}

# Read Smoobu, PayPal, webhook HMAC, and encryption secrets from Secrets Manager.
# The DB secret is already covered by the db_secret_read attachment above.
# The wildcard suffix (*) accommodates the 6-character random suffix that
# Secrets Manager appends to the secret ARN at creation time.
data "aws_iam_policy_document" "lambda_secrets_read" {
  statement {
    sid    = "AllowReadBookingSecrets"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [
      "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.smoobu_secret_name}*",
      "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.paypal_secret_name}*",
      "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.webhook_secret_name}*",
      "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.encryption_secret_name}*",
      "arn:aws:secretsmanager:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:secret:${var.booking_api_secret_name}*",
    ]
  }
}

resource "aws_iam_policy" "lambda_secrets_read" {
  name        = "${var.project}-${var.environment}-lambda-secrets-read"
  description = "Allows Lambda functions to read Smoobu, PayPal, webhook, encryption, and combined booking-api secrets."
  policy      = data.aws_iam_policy_document.lambda_secrets_read.json

  tags = {
    Name = "${var.project}-${var.environment}-lambda-secrets-read-policy"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_secrets_read" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_secrets_read.arn
}

##############################################################################
# Placeholder Lambda code archives
#
# archive_file zips the placeholder handler so Terraform can manage the
# function without a separate build pipeline.  CI/CD replaces the deployed
# code via `aws lambda update-function-code` once the real backend is ready.
# The generated .zip files are gitignored (see infra/.gitignore).
##############################################################################

data "archive_file" "booking_api_placeholder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/booking_api"
  output_path = "${path.module}/lambda/booking_api.zip"
}

data "archive_file" "webhooks_placeholder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/webhooks"
  output_path = "${path.module}/lambda/webhooks.zip"
}

##############################################################################
# CloudWatch log groups
#
# Pre-creating log groups sets retention explicitly and prevents the first
# Lambda invocation from racing against auto-created groups that have no
# retention policy (logs would accumulate indefinitely).
##############################################################################

resource "aws_cloudwatch_log_group" "booking_api" {
  name              = "/aws/lambda/${var.project}-${var.environment}-booking-api"
  retention_in_days = local.cloudwatch_log_retention_days

  tags = {
    Name = "${var.project}-${var.environment}-booking-api-logs"
  }
}

resource "aws_cloudwatch_log_group" "webhooks" {
  name              = "/aws/lambda/${var.project}-${var.environment}-webhooks"
  retention_in_days = local.cloudwatch_log_retention_days

  tags = {
    Name = "${var.project}-${var.environment}-webhooks-logs"
  }
}

##############################################################################
# Shared Lambda environment variables
##############################################################################

locals {
  lambda_common_env = {
    BOOKING_API_ENVIRONMENT = var.environment
    BOOKING_API_LOG_LEVEL   = var.booking_api_log_level
    DB_SECRET_NAME          = var.db_secret_name
    SMOOBU_SECRET           = var.smoobu_secret_name
    SMOOBU_CUSTOMER_ID      = tostring(var.smoobu_customer_id)
    PAYPAL_SECRET           = var.paypal_secret_name
    PAYPAL_BASE_URL         = var.paypal_base_url
    PAYPAL_HOLD_TTL_MINUTES = tostring(var.paypal_hold_ttl_minutes)
    DEPOSIT_HOLD_TTL_HOURS  = tostring(var.deposit_hold_ttl_hours)

    # Base URL for the staff confirm/reject links emailed on every manual
    # deposit booking (depositHolds.ts buildStaffActionUrl). Left unset, this
    # silently rendered schemeless links like "/api/staff/deposit-review/..."
    # that clients mangled into "http://api/..." — found during the
    # live-acceptance-test.md pass.
    #
    # Built from the REST API id rather than aws_api_gateway_stage.main.invoke_url:
    # the stage depends on the deployment, which depends on the integrations,
    # which depend on these Lambda functions — referencing the stage here
    # creates a cycle. stage_name is always var.environment (see api_gateway.tf),
    # so this reproduces the same invoke_url without the cycle.
    DEPOSIT_STAFF_CONFIRM_BASE_URL = "https://${aws_api_gateway_rest_api.main.id}.execute-api.${data.aws_region.current.name}.amazonaws.com/${var.environment}"

    # In-Lambda TTL cache (src/memoryCache.ts). There is no Redis client in
    # booking-api's dependencies — src/cacheFactory.ts:71 RedisAdapter is a
    # stub — so "redis" is not a usable value here. See cacheFactory.getCacheBackend().
    CACHE_BACKEND = "memory"

    SES_CONFIG_SET    = aws_ses_configuration_set.booking.name
    SES_FROM_ADDRESS  = local.ses_from_email
    WEBHOOK_SECRET    = var.webhook_secret_name
    ENCRYPTION_SECRET = var.encryption_secret_name

    # Guest-facing contact details used by the deposit handoff and email
    # templates. Previously read by config.ts but never supplied, so deployed
    # Lambdas silently fell back to hardcoded defaults.
    CONTACT_EMAIL        = var.contact_email
    CONTACT_WHATSAPP_URL = var.contact_whatsapp_url

    # Internal alerts (guest cancellations, deposit reviews). When empty the
    # booking API logs a warning and skips the notification rather than failing
    # the guest request that triggered it.
    STAFF_NOTIFICATION_EMAIL = var.staff_notification_email

    # Deposit receipt uploads. Presigned PUT/GET are issued against this bucket.
    S3_DEPOSIT_RECEIPT_BUCKET = aws_s3_bucket.deposit_receipts.bucket
    S3_DEPOSIT_RECEIPT_REGION = data.aws_region.current.name

    # CAPTCHA provider for server-side verification of inbound X-Captcha-Token
    # headers. This MUST match the widget the frontend ships
    # (react-google-recaptcha-v3 / REACT_APP_CAPTCHA_SITE_KEY) — a mismatch makes
    # every verification fail, which turns a CAPTCHA challenge into a hard 403 the
    # guest cannot clear. The verification secret itself is NOT set here: it is read
    # from the combined Secrets Manager entry below as `captchaSecretKey`, so the
    # live secret never lands in Lambda env vars or Terraform state.
    CAPTCHA_PROVIDER = var.captcha_provider

    # Server-side conversion reporting. Only the public IDs live here — the GA4
    # API secret (`ga4ApiSecret`) and Meta CAPI token (`metaCapiAccessToken`) are
    # read from the combined Secrets Manager entry below, so neither lands in
    # Lambda env vars or Terraform state. With either half absent the reporter is
    # inert, which is what lets the code deploy before the secrets exist.
    GA4_MEASUREMENT_ID = var.ga4_measurement_id
    META_PIXEL_ID      = var.meta_pixel_id

    # The booking API reads all provider secrets from a single combined
    # Secrets Manager entry via the Lambda Extensions HTTP cache layer.
    BOOKING_API_SECRETS_MANAGER_SECRET_ID = var.booking_api_secret_name
  }
}

##############################################################################
# booking_api Lambda
#
# Handles: POST /api/availability/quote, GET /api/calendar/{slug},
#          POST /api/bookings/hold, POST /api/bookings/{id}/paypal/*,
#          GET /api/deposit-handoff, portal routes.
# VPC placement: private subnets → can reach RDS directly.
##############################################################################

resource "aws_lambda_function" "booking_api" {
  function_name = "${var.project}-${var.environment}-booking-api"
  description   = "Booking API: availability, holds, payments, portal."

  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"] # Graviton2 — ~20% cheaper and faster than x86_64.

  role = aws_iam_role.lambda_exec.arn

  filename         = data.archive_file.booking_api_placeholder.output_path
  source_code_hash = data.archive_file.booking_api_placeholder.output_base64sha256

  # Terraform owns this function's CONFIGURATION; CI owns its CODE, uploaded with
  # `aws lambda update-function-code`. Without this, every apply would reset the
  # live function to the placeholder zip below — and CI only re-uploads some of
  # the functions, so the rest would be left running a stub indefinitely.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  memory_size = var.booking_api_lambda_memory_mb
  timeout     = var.booking_api_lambda_timeout_seconds

  # Private VPC subnets — allows direct connections to RDS.
  # Outbound internet access (Smoobu API, PayPal API, Secrets Manager) routes
  # through the NAT gateway.
  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = merge(local.lambda_common_env, {
      ALLOWED_ORIGINS             = var.booking_api_allowed_origins
      BOOKING_API_ALLOWED_ORIGINS = var.booking_api_allowed_origins
    })
  }

  # Log group must exist before first invocation to set retention correctly.
  depends_on = [
    aws_cloudwatch_log_group.booking_api,
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_vpc_access,
  ]

  tags = {
    Name = "${var.project}-${var.environment}-booking-api"
  }
}

##############################################################################
# webhooks Lambda
#
# Handles: POST /api/webhooks/smoobu, POST /api/webhooks/paypal.
# Isolated from booking_api to contain blast radius and allow independent
# scaling/deployment of the webhook ingestion path.
# Same VPC placement so it can write events directly to RDS.
##############################################################################

resource "aws_lambda_function" "webhooks" {
  function_name = "${var.project}-${var.environment}-webhooks"
  description   = "Webhook receiver: Smoobu and PayPal event ingestion."

  runtime       = "nodejs22.x"
  handler       = "index.handler"
  architectures = ["arm64"]

  role = aws_iam_role.lambda_exec.arn

  filename         = data.archive_file.webhooks_placeholder.output_path
  source_code_hash = data.archive_file.webhooks_placeholder.output_base64sha256

  # Terraform owns this function's CONFIGURATION; CI owns its CODE, uploaded with
  # `aws lambda update-function-code`. Without this, every apply would reset the
  # live function to the placeholder zip below — and CI only re-uploads some of
  # the functions, so the rest would be left running a stub indefinitely.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  # Webhook handlers must respond within the provider's retry timeout.
  # Both Smoobu and PayPal retry on non-2xx; a fast, simple response avoids
  # duplicate event delivery.
  memory_size = 256
  timeout     = 30

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.lambda_common_env
  }

  depends_on = [
    aws_cloudwatch_log_group.webhooks,
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_vpc_access,
  ]

  tags = {
    Name = "${var.project}-${var.environment}-webhooks"
  }
}

##############################################################################
# Lambda permissions — allow API Gateway to invoke each function
#
# source_arn restricts invocation to this specific API so other API Gateways
# (or the console test button using a different execution ARN) cannot invoke
# the functions without explicit permission.
##############################################################################

resource "aws_lambda_permission" "booking_api_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.booking_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}

resource "aws_lambda_permission" "webhooks_apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhooks.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.main.execution_arn}/*/*"
}


##############################################################################
# hold_expiry Lambda — scheduled worker
#
# Runs on a cron schedule (every 1 minute) via EventBridge to expire holds
# that have passed their `expiresAt` timestamp. For each expired hold:
#   1. Marks the hold as "expired" in the DB.
#   2. Cancels the corresponding Smoobu reservation (if one exists).
#   3. Marks the booking session as "hold_expired".
#
# Same VPC placement as booking_api so it can reach RDS.
# Uses the shared execution role (same secrets and network access).
##############################################################################

data "archive_file" "hold_expiry_placeholder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/hold_expiry"
  output_path = "${path.module}/lambda/hold_expiry.zip"
}

resource "aws_cloudwatch_log_group" "hold_expiry" {
  name              = "/aws/lambda/${var.project}-${var.environment}-hold-expiry"
  retention_in_days = local.cloudwatch_log_retention_days

  tags = {
    Name = "${var.project}-${var.environment}-hold-expiry-logs"
  }
}

resource "aws_lambda_function" "hold_expiry" {
  function_name = "${var.project}-${var.environment}-hold-expiry"
  description   = "Hold expiry worker: expires stale holds and cancels Smoobu reservations."

  runtime       = "nodejs22.x"
  handler       = "holdExpiryHandler.handler"
  architectures = ["arm64"]

  role = aws_iam_role.lambda_exec.arn

  filename         = data.archive_file.hold_expiry_placeholder.output_path
  source_code_hash = data.archive_file.hold_expiry_placeholder.output_base64sha256

  # Terraform owns this function's CONFIGURATION; CI owns its CODE, uploaded with
  # `aws lambda update-function-code`. Without this, every apply would reset the
  # live function to the placeholder zip below — and CI only re-uploads some of
  # the functions, so the rest would be left running a stub indefinitely.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  memory_size = 256
  timeout     = 60

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.lambda_common_env
  }

  depends_on = [
    aws_cloudwatch_log_group.hold_expiry,
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_vpc_access,
  ]

  tags = {
    Name = "${var.project}-${var.environment}-hold-expiry"
  }
}

##############################################################################
# EventBridge schedule — triggers hold_expiry every 1 minute
##############################################################################

resource "aws_cloudwatch_event_rule" "hold_expiry_schedule" {
  name                = "${var.project}-${var.environment}-hold-expiry-schedule"
  description         = "Triggers the hold expiry worker every minute to clean up expired holds."
  schedule_expression = "rate(1 minute)"

  tags = {
    Name = "${var.project}-${var.environment}-hold-expiry-schedule"
  }
}

resource "aws_cloudwatch_event_target" "hold_expiry_target" {
  rule = aws_cloudwatch_event_rule.hold_expiry_schedule.name
  arn  = aws_lambda_function.hold_expiry.arn
}

resource "aws_lambda_permission" "hold_expiry_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.hold_expiry.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.hold_expiry_schedule.arn
}


##############################################################################
# payment_reconciliation Lambda — scheduled worker
#
# Runs on a cron schedule (every 5 minutes) via EventBridge to reconcile
# "pending PayPal" sessions. For each pending payment:
#   1. Queries PayPal Orders API for the actual order status.
#   2. If COMPLETED → confirms the booking (missed webhook recovery).
#   3. If VOIDED/declined → marks as failed.
#   4. If stale (>2h pending) → marks as failed (abandoned).
#   5. Alerts on any missed-webhook confirmations.
#
# Same VPC placement as booking_api so it can reach RDS.
# Uses the shared execution role (same secrets and network access).
##############################################################################

data "archive_file" "payment_reconciliation_placeholder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/payment_reconciliation"
  output_path = "${path.module}/lambda/payment_reconciliation.zip"
}

resource "aws_cloudwatch_log_group" "payment_reconciliation" {
  name              = "/aws/lambda/${var.project}-${var.environment}-payment-reconciliation"
  retention_in_days = local.cloudwatch_log_retention_days

  tags = {
    Name = "${var.project}-${var.environment}-payment-reconciliation-logs"
  }
}

resource "aws_lambda_function" "payment_reconciliation" {
  function_name = "${var.project}-${var.environment}-payment-reconciliation"
  description   = "Payment reconciliation: resolves pending PayPal sessions and alerts anomalies."

  runtime       = "nodejs22.x"
  handler       = "paymentReconciliationHandler.handler"
  architectures = ["arm64"]

  role = aws_iam_role.lambda_exec.arn

  filename         = data.archive_file.payment_reconciliation_placeholder.output_path
  source_code_hash = data.archive_file.payment_reconciliation_placeholder.output_base64sha256

  # Terraform owns this function's CONFIGURATION; CI owns its CODE, uploaded with
  # `aws lambda update-function-code`. Without this, every apply would reset the
  # live function to the placeholder zip below — and CI only re-uploads some of
  # the functions, so the rest would be left running a stub indefinitely.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  memory_size = 256
  timeout     = 120

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.lambda_common_env
  }

  depends_on = [
    aws_cloudwatch_log_group.payment_reconciliation,
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_vpc_access,
  ]

  tags = {
    Name = "${var.project}-${var.environment}-payment-reconciliation"
  }
}

##############################################################################
# EventBridge schedule — triggers payment_reconciliation every 5 minutes
##############################################################################

resource "aws_cloudwatch_event_rule" "payment_reconciliation_schedule" {
  name                = "${var.project}-${var.environment}-payment-reconciliation-schedule"
  description         = "Triggers the payment reconciliation worker every 5 minutes to resolve pending PayPal sessions."
  schedule_expression = "rate(5 minutes)"

  tags = {
    Name = "${var.project}-${var.environment}-payment-reconciliation-schedule"
  }
}

resource "aws_cloudwatch_event_target" "payment_reconciliation_target" {
  rule = aws_cloudwatch_event_rule.payment_reconciliation_schedule.name
  arn  = aws_lambda_function.payment_reconciliation.arn
}

resource "aws_lambda_permission" "payment_reconciliation_eventbridge" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.payment_reconciliation.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.payment_reconciliation_schedule.arn
}

##############################################################################
# migration Lambda
#
# Applies pending SQL migrations from inside the VPC.
#
# RDS is private and its security group admits 5432 from the Lambda security
# group only, so `npm run migrate` cannot reach it from a laptop or a GitHub
# Actions runner. This function sits in that security group and is the
# sanctioned way to migrate a deployed environment.
#
# Invoked manually (or by CI before a code deploy) — never on a schedule, and
# deliberately given no trigger. Ordering matters: a migration must land BEFORE
# the code that reads the new columns, or every query on the changed table fails.
##############################################################################

data "archive_file" "migration_placeholder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/migration"
  output_path = "${path.module}/lambda/migration.zip"
}

resource "aws_cloudwatch_log_group" "migration" {
  name              = "/aws/lambda/${var.project}-${var.environment}-migration"
  retention_in_days = local.cloudwatch_log_retention_days

  tags = {
    Name = "${var.project}-${var.environment}-migration-logs"
  }
}

resource "aws_lambda_function" "migration" {
  function_name = "${var.project}-${var.environment}-migration"
  description   = "Schema migration runner: applies pending booking-api migrations against RDS."

  runtime       = "nodejs22.x"
  handler       = "migrationHandler.handler"
  architectures = ["arm64"]

  role = aws_iam_role.lambda_exec.arn

  filename         = data.archive_file.migration_placeholder.output_path
  source_code_hash = data.archive_file.migration_placeholder.output_base64sha256

  # Terraform owns this function's CONFIGURATION; CI owns its CODE, uploaded with
  # `aws lambda update-function-code`. Without this, every apply would reset the
  # live function to the placeholder zip below — and CI only re-uploads some of
  # the functions, so the rest would be left running a stub indefinitely.
  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  memory_size = 512
  # Generous: the whole run is one transaction holding an exclusive lock, and a
  # migration that rewrites a large table must not be cut off half way.
  timeout = 300

  # Reserved at 1 so two invocations can never run concurrently. The exclusive
  # table lock already serialises them, but a second invocation would block on
  # that lock and burn its whole timeout waiting.
  reserved_concurrent_executions = 1

  vpc_config {
    subnet_ids         = aws_subnet.private[*].id
    security_group_ids = [aws_security_group.lambda.id]
  }

  environment {
    variables = local.lambda_common_env
  }

  depends_on = [
    aws_cloudwatch_log_group.migration,
    aws_iam_role_policy_attachment.lambda_basic_execution,
    aws_iam_role_policy_attachment.lambda_vpc_access,
  ]

  tags = {
    Name = "${var.project}-${var.environment}-migration"
  }
}
