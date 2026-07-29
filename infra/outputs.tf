##############################################################################
# outputs.tf — Key resource references exposed after terraform apply.
#
# These are consumed by CI/CD pipelines, application config, and the
# booking-api Lambda environment variables.
#
# Outputs for not-yet-provisioned resources (RDS, API Gateway, ElastiCache,
# Secrets Manager, CloudWatch) are added incrementally as each task lands:
#   Task 2.7 → RDS outputs
#   Task 2.8 → API Gateway outputs
#   Task 2.10 → ElastiCache, Secrets Manager, CloudWatch outputs
##############################################################################

# ---------------------------------------------------------------------------
# Networking  (task 2.6)
# ---------------------------------------------------------------------------

output "vpc_id" {
  description = "ID of the VPC created for the booking engine."
  value       = aws_vpc.main.id
}

output "private_subnet_ids" {
  description = "IDs of the app-tier private subnets (Lambda functions)."
  value       = aws_subnet.private[*].id
}

output "data_subnet_ids" {
  description = "IDs of the data-tier private subnets (RDS)."
  value       = aws_subnet.data[*].id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets (NAT gateway)."
  value       = aws_subnet.public[*].id
}

output "nat_gateway_public_ip" {
  description = "Public IP of the NAT gateway (add to Smoobu/PayPal IP allowlists). Null when nat_gateway_type is not 'managed'."
  value       = try(aws_eip.nat[0].public_ip, null)
}

output "sg_lambda_id" {
  description = "Security group ID assigned to booking API Lambda functions."
  value       = aws_security_group.lambda.id
}

output "sg_rds_id" {
  description = "Security group ID assigned to the RDS instance."
  value       = aws_security_group.rds.id
}

# ---------------------------------------------------------------------------
# Database  (task 2.7)
# ---------------------------------------------------------------------------

output "db_instance_id" {
  description = "RDS instance identifier."
  value       = aws_db_instance.main.id
}

output "db_endpoint" {
  description = "RDS instance endpoint (host:port). Used as the DB_HOST env var for Lambda."
  value       = aws_db_instance.main.endpoint
  sensitive   = true
}

output "db_address" {
  description = "RDS instance hostname (without port)."
  value       = aws_db_instance.main.address
  sensitive   = true
}

output "db_port" {
  description = "RDS instance port (always 5432 for PostgreSQL)."
  value       = aws_db_instance.main.port
}

output "db_name" {
  description = "Name of the initial database created inside the RDS instance."
  value       = aws_db_instance.main.db_name
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the RDS master credentials."
  value       = aws_secretsmanager_secret.db.arn
  sensitive   = true
}

output "db_secret_read_policy_arn" {
  description = "ARN of the IAM policy that grants read access to the DB secret. Attached to the Lambda execution role."
  value       = aws_iam_policy.db_secret_read.arn
}

# ---------------------------------------------------------------------------
# Lambda  (task 2.8)
# ---------------------------------------------------------------------------

output "booking_api_lambda_arn" {
  description = "ARN of the booking_api Lambda function."
  value       = aws_lambda_function.booking_api.arn
}

output "booking_api_lambda_name" {
  description = "Name of the booking_api Lambda function (used by CI/CD for update-function-code)."
  value       = aws_lambda_function.booking_api.function_name
}

output "webhooks_lambda_arn" {
  description = "ARN of the webhooks Lambda function."
  value       = aws_lambda_function.webhooks.arn
}

output "webhooks_lambda_name" {
  description = "Name of the webhooks Lambda function (used by CI/CD for update-function-code)."
  value       = aws_lambda_function.webhooks.function_name
}

output "lambda_execution_role_arn" {
  description = "ARN of the shared Lambda execution IAM role."
  value       = aws_iam_role.lambda_exec.arn
}

# ---------------------------------------------------------------------------
# API Gateway  (task 2.8)
# ---------------------------------------------------------------------------

output "api_gateway_id" {
  description = "ID of the REST API."
  value       = aws_api_gateway_rest_api.main.id
}

output "api_gateway_invoke_url" {
  description = "Base invocation URL for the booking API stage (e.g. https://{id}.execute-api.{region}.amazonaws.com/{stage})."
  value       = aws_api_gateway_stage.main.invoke_url
}

output "api_gateway_stage_arn" {
  description = "ARN of the API Gateway stage (used for WAF association and CloudWatch log subscriptions)."
  value       = aws_api_gateway_stage.main.arn
}

output "api_gateway_execution_arn" {
  description = "Execution ARN prefix for the API Gateway (used to build Lambda permission source_arn)."
  value       = aws_api_gateway_rest_api.main.execution_arn
}

# ---------------------------------------------------------------------------
# Frontend S3 + CloudFront  (task 2.9)
# ---------------------------------------------------------------------------

output "frontend_bucket_name" {
  description = "S3 bucket for React frontend build artifacts. Null when frontend_static_hosting_enabled is false."
  value       = try(aws_s3_bucket.frontend[0].bucket, null)
}

output "frontend_cloudfront_distribution_id" {
  description = "CloudFront distribution ID for frontend CDN invalidations. Null when frontend_static_hosting_enabled is false."
  value       = try(aws_cloudfront_distribution.frontend[0].id, null)
}

output "frontend_cloudfront_distribution_arn" {
  description = "CloudFront distribution ARN for the frontend CDN. Null when frontend_static_hosting_enabled is false."
  value       = try(aws_cloudfront_distribution.frontend[0].arn, null)
}

output "frontend_cloudfront_domain_name" {
  description = "CloudFront domain name for the frontend CDN. Null when frontend_static_hosting_enabled is false."
  value       = try(aws_cloudfront_distribution.frontend[0].domain_name, null)
}

output "frontend_cloudfront_hosted_zone_id" {
  description = "CloudFront hosted zone ID for Route 53 alias records. Null when frontend_static_hosting_enabled is false."
  value       = try(aws_cloudfront_distribution.frontend[0].hosted_zone_id, null)
}

# ---------------------------------------------------------------------------
# WAF  (task 2.8)
# ---------------------------------------------------------------------------

output "waf_web_acl_arn" {
  description = "ARN of the WAF WebACL protecting the booking API stage. Null when waf_enabled is false."
  value       = try(aws_wafv2_web_acl.booking_api[0].arn, null)
}

output "waf_web_acl_id" {
  description = "ID of the WAF WebACL (used if the WebACL is later associated with a CloudFront distribution). Null when waf_enabled is false."
  value       = try(aws_wafv2_web_acl.booking_api[0].id, null)
}

# ---------------------------------------------------------------------------
# Supporting services  (task 2.10)
# ---------------------------------------------------------------------------

output "ses_domain_identity_arn" {
  description = "SES domain identity ARN used for transactional booking email."
  value       = aws_ses_domain_identity.booking.arn
}

output "ses_domain_verification_token" {
  description = "SES TXT verification token. Add as _amazonses.<domain> when ses_route53_zone_id is not set."
  value       = aws_ses_domain_identity.booking.verification_token
  sensitive   = true
}

output "ses_dkim_tokens" {
  description = "SES DKIM tokens. Add each token as <token>._domainkey CNAME to <token>.dkim.amazonses.com when ses_route53_zone_id is not set."
  value       = aws_ses_domain_dkim.booking.dkim_tokens
}

output "ses_from_email" {
  description = "Default transactional email From address configured for booking Lambda functions."
  value       = local.ses_from_email
}

output "cloudwatch_alert_topic_arn" {
  description = "SNS topic ARN used by CloudWatch alarms."
  value       = aws_sns_topic.alerts.arn
}

output "api_gateway_access_log_group_name" {
  description = "CloudWatch log group name for API Gateway access logs."
  value       = aws_cloudwatch_log_group.api_gateway_access.name
}

output "deposit_receipts_bucket_name" {
  description = "Private S3 bucket holding guest deposit receipt uploads."
  value       = aws_s3_bucket.deposit_receipts.bucket
}

output "migration_lambda_name" {
  description = "Name of the schema migration runner. Invoke before deploying code that reads new columns."
  value       = aws_lambda_function.migration.function_name
}

output "hold_expiry_lambda_name" {
  description = "Scheduled worker that expires stale holds. CI must redeploy it or expired holds stop releasing inventory."
  value       = aws_lambda_function.hold_expiry.function_name
}

output "payment_reconciliation_lambda_name" {
  description = "Scheduled worker that resolves PayPal payments whose webhook was missed."
  value       = aws_lambda_function.payment_reconciliation.function_name
}
