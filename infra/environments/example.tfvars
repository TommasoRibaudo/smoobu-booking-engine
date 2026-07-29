# environments/example.tfvars
# Copy this file to dev.tfvars / staging.tfvars / prod.tfvars and fill in values.
# .tfvars files are gitignored — never commit them.
#
# Apply: terraform apply -var-file=environments/<env>.tfvars

environment = "dev" # dev | staging | prod
aws_region  = "us-east-1"

# Networking
vpc_cidr           = "10.0.0.0/16"
availability_zones = ["us-east-1a", "us-east-1b"]
public_subnet_cidrs = ["10.0.1.0/24", "10.0.2.0/24"]
app_subnet_cidrs    = ["10.0.11.0/24", "10.0.12.0/24"]
data_subnet_cidrs   = ["10.0.21.0/24", "10.0.22.0/24"]

# Domain
domain_name   = "example.com"
api_subdomain = "api"

# Frontend S3 + CloudFront hosting (opt-in)
frontend_static_hosting_enabled = false

# Booking API Lambda
booking_api_lambda_memory_mb       = 256
booking_api_lambda_timeout_seconds = 30
booking_api_log_level              = "debug" # debug | info | warn | error
booking_api_allowed_origins        = "http://localhost:3000"

# RDS PostgreSQL
db_instance_class           = "db.t4g.micro"
db_allocated_storage_gb     = 20
db_max_allocated_storage_gb = 50
db_name                     = "booking_engine"
db_multi_az                 = false
db_backup_retention_days    = 1

# SES transactional email
ses_domain_name = "example.com"
ses_from_email  = "reservations@example.com"

# CloudWatch alerting
cloudwatch_alert_email_addresses = []
cloudwatch_alarm_actions_enabled = false

# WAF
waf_rate_limit_per_5min = 1000

# Secrets Manager name prefixes
smoobu_secret_name     = "booking-engine/dev/smoobu"
paypal_secret_name     = "booking-engine/dev/paypal"
db_secret_name         = "booking-engine/dev/db"
webhook_secret_name    = "booking-engine/dev/webhooks"
encryption_secret_name = "booking-engine/dev/encryption"
