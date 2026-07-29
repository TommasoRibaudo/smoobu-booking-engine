##############################################################################
# variables.tf — All input variables for the booking-engine infra.
#
# Values are provided via environment-specific .tfvars files in environments/.
# Sensitive defaults are intentionally omitted; they must be supplied at plan/
# apply time or stored in Secrets Manager (not hardcoded here).
##############################################################################

# ---------------------------------------------------------------------------
# Core / deployment context
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy all resources into."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment: dev | staging | prod."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "project" {
  description = "Project name used as a prefix in resource names and tags."
  type        = string
  default     = "booking-engine"
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR block for the VPC."
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to spread subnets across (≥ 2 for RDS Multi-AZ)."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets (NAT gateway, internet-facing resources)."
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "app_subnet_cidrs" {
  description = "CIDR blocks for the private application subnets (Lambda functions)."
  type        = list(string)
  default     = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "data_subnet_cidrs" {
  description = "CIDR blocks for the private data subnets (RDS). Kept separate from the app subnets to enforce app/data network segmentation."
  type        = list(string)
  default     = ["10.0.21.0/24", "10.0.22.0/24"]
}

# ---------------------------------------------------------------------------
# Booking API
# ---------------------------------------------------------------------------

variable "booking_api_lambda_memory_mb" {
  description = "Memory (MB) allocated to each booking API Lambda function."
  type        = number
  default     = 256
}

variable "booking_api_lambda_timeout_seconds" {
  description = "Maximum execution time (seconds) for booking API Lambda functions."
  type        = number
  default     = 30
}

variable "booking_api_allowed_origins" {
  description = "Comma-separated list of allowed CORS origins for the booking API."
  type        = string
  default     = ""
}

variable "smoobu_customer_id" {
  description = "Smoobu account customer ID, required for availability search."
  type        = number
}

variable "booking_api_log_level" {
  description = "Log level for the booking API (debug | info | warn | error | silent)."
  type        = string
  default     = "info"
}

# ---------------------------------------------------------------------------
# Domain / routing
# ---------------------------------------------------------------------------

variable "domain_name" {
  description = "Root domain name (e.g. example.com). Used for API Gateway and SES."
  type        = string
}

variable "api_subdomain" {
  description = "Subdomain for the booking API (e.g. 'api' → api.example.com)."
  type        = string
  default     = "api"
}

# ---------------------------------------------------------------------------
# Frontend static hosting / CDN
#
# The current production frontend still deploys through the existing FTPS
# workflow. These controls provision an AWS static-site origin + CloudFront
# distribution when/if the frontend is moved behind AWS. This is not a
# deposit-receipt upload bucket.
# ---------------------------------------------------------------------------

variable "frontend_static_hosting_enabled" {
  description = "Provision a private S3 bucket and CloudFront distribution for the React frontend build artifacts."
  type        = bool
  default     = false
}

variable "frontend_bucket_name" {
  description = "Optional globally unique S3 bucket name for frontend build artifacts. Defaults to project-environment-account."
  type        = string
  default     = null
}

variable "frontend_cdn_aliases" {
  description = "Optional custom domain aliases for the frontend CloudFront distribution. Requires frontend_cdn_acm_certificate_arn when non-empty."
  type        = list(string)
  default     = []
}

variable "frontend_cdn_acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for frontend_cdn_aliases. Leave null when using the default CloudFront domain."
  type        = string
  default     = null
}

variable "frontend_cdn_price_class" {
  description = "CloudFront price class for frontend distribution edge locations."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition = contains([
      "PriceClass_100",
      "PriceClass_200",
      "PriceClass_All",
    ], var.frontend_cdn_price_class)
    error_message = "frontend_cdn_price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

# ---------------------------------------------------------------------------
# Database (RDS PostgreSQL)
# ---------------------------------------------------------------------------

variable "db_snapshot_identifier" {
  description = "Optional RDS snapshot ARN to restore from when creating the DB instance. Leave null for a fresh database. Used during region migration to restore data from a snapshot copied from us-east-1."
  type        = string
  default     = null
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage_gb" {
  description = "Initial allocated storage for the RDS instance (GB)."
  type        = number
  default     = 20
}

variable "db_max_allocated_storage_gb" {
  description = "Maximum storage autoscaling ceiling for the RDS instance (GB)."
  type        = number
  default     = 100
}

variable "db_name" {
  description = "Name of the initial database created in the RDS instance."
  type        = string
  default     = "booking_engine"
}

variable "db_username" {
  description = "Master username for the RDS instance."
  type        = string
  default     = "booking_admin"
}

variable "db_multi_az" {
  description = "Enable Multi-AZ deployment for the RDS instance."
  type        = bool
  default     = false
}

variable "db_backup_retention_days" {
  description = "Number of days to retain automated RDS backups (0 disables backups)."
  type        = number
  default     = 7
}

# ---------------------------------------------------------------------------
# SES / transactional email
# ---------------------------------------------------------------------------

variable "ses_domain_name" {
  description = "Domain identity to verify in SES for transactional booking email. Defaults to domain_name when null."
  type        = string
  default     = null
}

variable "ses_from_email" {
  description = "Default From address for transactional booking email. Defaults to reservations@ses_domain_name when null."
  type        = string
  default     = null
}

variable "ses_route53_zone_id" {
  description = "Optional Route 53 hosted zone ID for creating SES verification, DKIM, and MAIL FROM records automatically."
  type        = string
  default     = null
}

# ---------------------------------------------------------------------------
# CloudWatch / alerting
# ---------------------------------------------------------------------------

variable "cloudwatch_log_retention_days" {
  description = "CloudWatch log retention in days. Defaults to 90 in prod and 14 elsewhere when null."
  type        = number
  default     = null
}

variable "cloudwatch_alert_email_addresses" {
  description = "Email addresses to subscribe to the CloudWatch alert SNS topic. Empty list creates the topic without subscriptions."
  type        = list(string)
  default     = []
}

variable "cloudwatch_alarm_actions_enabled" {
  description = "Whether CloudWatch alarms should publish to the alert SNS topic."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Cost optimization toggles
# ---------------------------------------------------------------------------

variable "waf_enabled" {
  description = "Provision the WAF WebACL and its API Gateway association. When false, API Gateway built-in throttling is the only rate control (~$8/month saved)."
  type        = bool
  default     = true
}

variable "nat_gateway_type" {
  description = "NAT strategy: 'managed' uses the AWS-managed NAT Gateway (~$32/month); 'fck-nat' uses a t4g.nano EC2 instance (~$3/month)."
  type        = string
  default     = "managed"

  validation {
    condition     = contains(["managed", "fck-nat"], var.nat_gateway_type)
    error_message = "nat_gateway_type must be either \"managed\" or \"fck-nat\"."
  }
}

# ---------------------------------------------------------------------------
# WAF / rate limiting
# ---------------------------------------------------------------------------

variable "waf_rate_limit_per_5min" {
  description = "Maximum number of requests per 5-minute window per IP before WAF blocks."
  type        = number
  default     = 500
}

# ---------------------------------------------------------------------------
# Secrets Manager — secret name prefixes
# (Actual secret values are never stored here; they are injected via AWS
#  Secrets Manager after infrastructure is provisioned.)
# ---------------------------------------------------------------------------

variable "smoobu_secret_name" {
  description = "AWS Secrets Manager secret name that holds the Smoobu API credentials."
  type        = string
  default     = "booking-engine/smoobu"
}

variable "paypal_base_url" {
  description = "PayPal REST API base URL. Defaults to the live endpoint since prod is the only environment; override to https://api-m.sandbox.paypal.com for a sandboxed deployment."
  type        = string
  default     = "https://api-m.paypal.com"
}

variable "paypal_secret_name" {
  description = "AWS Secrets Manager secret name that holds the PayPal API credentials."
  type        = string
  default     = "booking-engine/paypal"
}

variable "paypal_hold_ttl_minutes" {
  description = "How long a PayPal-backed hold blocks a property before it expires and the hold-expiry worker releases it. Code default is 60 if unset."
  type        = number
  default     = 60

  validation {
    condition     = var.paypal_hold_ttl_minutes > 0
    error_message = "paypal_hold_ttl_minutes must be a positive number of minutes."
  }
}

variable "deposit_hold_ttl_hours" {
  description = "How long a manual-deposit hold blocks a property before it expires, subject to the sliding min(this, half the time to check-in) cap in depositHolds.ts. Code default is 36 if unset."
  type        = number
  default     = 12

  validation {
    condition     = var.deposit_hold_ttl_hours > 0
    error_message = "deposit_hold_ttl_hours must be a positive number of hours."
  }
}

variable "db_secret_name" {
  description = "AWS Secrets Manager secret name that holds the RDS master credentials."
  type        = string
  default     = "booking-engine/db"
}

variable "webhook_secret_name" {
  description = "AWS Secrets Manager secret name that holds webhook HMAC signing secrets."
  type        = string
  default     = "booking-engine/webhooks"
}

variable "encryption_secret_name" {
  description = "AWS Secrets Manager secret name that holds the field-level encryption key."
  type        = string
  default     = "booking-engine/encryption"
}

variable "booking_api_secret_name" {
  description = "AWS Secrets Manager secret name that holds the combined booking API secrets (Smoobu key, PayPal creds, webhook secret, encryption key, portal session secret, and the optional captchaSecretKey)."
  type        = string
  default     = "booking-engine/booking-api"
}

variable "deposit_receipt_retention_days" {
  description = "How long uploaded deposit receipts are kept before the S3 lifecycle rule expires them."
  type        = number
  default     = 730

  validation {
    condition     = var.deposit_receipt_retention_days >= 30
    error_message = "deposit_receipt_retention_days must be at least 30 so receipts outlive a booking dispute."
  }
}

variable "staff_notification_email" {
  description = "Internal address that receives operational alerts (guest cancellations, deposit reviews). Must be a verified SES identity while the account is in the SES sandbox. Leave empty to disable staff notifications."
  type        = string
  default     = ""
}

variable "contact_email" {
  description = "Guest-facing contact address shown in emails and the deposit handoff."
  type        = string
  default     = "reservations@example.com"
}

variable "contact_whatsapp_url" {
  description = "Guest-facing WhatsApp link shown in emails and the deposit handoff."
  type        = string
  default     = "https://wa.me/contact"
}

variable "captcha_provider" {
  description = "CAPTCHA provider used for server-side token verification. Must match the widget the frontend ships (currently Google reCAPTCHA v3 via REACT_APP_CAPTCHA_SITE_KEY). The secret itself lives in the combined booking API secret as `captchaSecretKey`."
  type        = string
  default     = "recaptcha"

  validation {
    condition     = contains(["recaptcha", "hcaptcha"], var.captcha_provider)
    error_message = "captcha_provider must be either \"recaptcha\" or \"hcaptcha\"."
  }
}

variable "ga4_measurement_id" {
  description = "GA4 measurement ID (G-XXXXXXXXXX) the API reports funnel events to via the Measurement Protocol. Must match the tag in public/index.html. The matching API secret lives in the combined booking API secret as `ga4ApiSecret`; leave this blank to disable server-side GA4 reporting."
  type        = string
  default     = ""
}

variable "meta_pixel_id" {
  description = "Meta dataset/pixel ID the API reports Conversions API events to. Must match REACT_APP_META_PIXEL_ID so browser and server events deduplicate on event_id. The access token lives in the combined booking API secret as `metaCapiAccessToken`; leave this blank to disable server-side Meta reporting."
  type        = string
  default     = ""
}
