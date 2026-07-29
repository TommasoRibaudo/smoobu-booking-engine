##############################################################################
# database.tf — RDS PostgreSQL instance, subnet group, parameter group,
#               and Secrets Manager credential storage.
#
# Security posture:
#   • Instance placed in private subnets; no public accessibility.
#   • Encryption at rest via AWS-managed KMS key (aws/rds).
#   • Encryption in transit enforced via parameter group (ssl = 1).
#   • Credentials generated at plan time with the random provider,
#     stored in Secrets Manager, and never committed to source control.
#   • Automated backups retained per var.db_backup_retention_days.
#   • Storage autoscaling capped at var.db_max_allocated_storage_gb.
#   • Deletion protection enabled in production.
##############################################################################

##############################################################################
# Random master password
#
# Generated once at first apply; stored only in Secrets Manager and in
# Terraform state (state is encrypted at rest in the S3 backend).
##############################################################################

resource "random_password" "db_master" {
  length  = 32
  special = true
  # Exclude characters that require shell quoting in connection strings.
  override_special = "!#$%&*+-=?^_{|}~"
}

##############################################################################
# Secrets Manager — DB master credentials
#
# JSON payload stored:
#   { "username": "...", "password": "...", "dbname": "...",
#     "host": "...", "port": 5432, "engine": "postgres" }
#
# The `host` field is populated via a separate aws_secretsmanager_secret_version
# that depends on the RDS instance so it can include the endpoint address.
# A placeholder secret is created first; a post-apply update adds the host.
#
# NOTE: Secrets Manager automatic rotation requires a rotation Lambda (task
# 2.10). The secret is created here without rotation; rotation will be
# enabled once the rotation Lambda is provisioned.
##############################################################################

resource "aws_secretsmanager_secret" "db" {
  name        = var.db_secret_name
  description = "RDS PostgreSQL master credentials for the booking engine (${var.environment})."

  # Allow overwrite if a previous secret was deleted within the recovery window.
  recovery_window_in_days = var.environment == "prod" ? 30 : 7

  tags = {
    Name = "${var.project}-${var.environment}-db-secret"
  }
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id

  secret_string = jsonencode({
    engine   = "postgres"
    host     = aws_db_instance.main.address
    port     = 5432
    dbname   = var.db_name
    username = var.db_username
    password = random_password.db_master.result
  })

  # Ensure the RDS instance is created before writing the endpoint into the
  # secret, so the host field is always the real address.
  depends_on = [aws_db_instance.main]
}

##############################################################################
# DB subnet group — spans all private subnets (≥ 2 AZs for Multi-AZ support)
##############################################################################

resource "aws_db_subnet_group" "main" {
  name        = "${var.project}-${var.environment}-db-subnet-group"
  description = "Data-tier subnets for the booking engine RDS PostgreSQL instance."
  subnet_ids  = aws_subnet.data[*].id

  tags = {
    Name = "${var.project}-${var.environment}-db-subnet-group"
  }
}

##############################################################################
# DB parameter group — PostgreSQL 15
#
# Enforces SSL connections from all clients, consistent with the
# encryption-in-transit requirement.
##############################################################################

resource "aws_db_parameter_group" "postgres15" {
  name        = "${var.project}-${var.environment}-postgres15"
  family      = "postgres15"
  description = "Booking engine PostgreSQL 15 parameters."

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "immediate"
  }

  # log_connections / log_disconnections aid audit trails and debugging.
  parameter {
    name         = "log_connections"
    value        = "1"
    apply_method = "immediate"
  }

  parameter {
    name         = "log_disconnections"
    value        = "1"
    apply_method = "immediate"
  }

  # log_min_duration_statement = 1000 ms — surface slow queries without
  # flooding CloudWatch Logs with every statement.
  parameter {
    name         = "log_min_duration_statement"
    value        = "1000"
    apply_method = "immediate"
  }

  tags = {
    Name = "${var.project}-${var.environment}-pg15-params"
  }

  lifecycle {
    create_before_destroy = true
  }
}

##############################################################################
# RDS PostgreSQL instance
##############################################################################

resource "aws_db_instance" "main" {
  identifier = "${var.project}-${var.environment}-db"

  # Engine
  engine               = "postgres"
  engine_version       = "15"
  instance_class       = var.db_instance_class
  parameter_group_name = aws_db_parameter_group.postgres15.name

  # Storage
  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  # Using the default aws/rds KMS key. A customer-managed CMK can be
  # substituted via a kms_key_id variable in a future hardening pass.

  # Credentials
  db_name  = var.db_name
  username = var.db_username
  password = random_password.db_master.result

  # Restore from snapshot during region migration (null = fresh database).
  # When set, db_name/username/password are ignored by RDS (taken from snapshot).
  snapshot_identifier = var.db_snapshot_identifier

  # Networking — private subnets only; no direct internet access.
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  # High availability
  multi_az = var.db_multi_az

  # Backups and maintenance
  backup_retention_period  = var.db_backup_retention_days
  backup_window            = "03:00-04:00" # UTC, low-traffic window
  maintenance_window       = "mon:04:00-mon:05:00"
  copy_tags_to_snapshot    = true
  delete_automated_backups = var.environment != "prod"

  # Minor version upgrades applied automatically during maintenance window.
  auto_minor_version_upgrade = true

  # Prevent accidental destruction in production.
  deletion_protection = var.environment == "prod"

  # On non-prod environments, allow destroy without a final snapshot to
  # simplify teardowns during development.
  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${var.project}-${var.environment}-db-final-snapshot" : null

  # CloudWatch Logs export — surface PostgreSQL logs without SSHing into the
  # instance.  Combined with the log_* parameters above this covers slow
  # queries, connections, and upgrades.
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  # Performance Insights is free for db.t4g.* and smaller; enable on all
  # envs for query-level observability.
  performance_insights_enabled          = true
  performance_insights_retention_period = 7

  tags = {
    Name = "${var.project}-${var.environment}-db"
  }

  lifecycle {
    # prevent_destroy must be a static literal — Terraform does not allow
    # variable references in lifecycle blocks. This is the production booking
    # database (reservations, payment state, guest PII); a stray
    # `terraform destroy` must not be able to take it out.
    #
    # To decommission deliberately: `terraform state rm aws_db_instance.main`,
    # then delete the instance explicitly. scripts/teardown-all.ps1 already
    # does this.
    prevent_destroy = true
  }
}

##############################################################################
# IAM policy — grants read access to the DB secret
#
# Attached to the Lambda execution role in lambda.tf (task 2.8) so that
# booking API functions can retrieve the DB password at runtime without
# ever having it in environment variables or code.
##############################################################################

data "aws_iam_policy_document" "db_secret_read" {
  statement {
    sid    = "AllowReadDBSecret"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [aws_secretsmanager_secret.db.arn]
  }
}

resource "aws_iam_policy" "db_secret_read" {
  name        = "${var.project}-${var.environment}-db-secret-read"
  description = "Allows Lambda functions to read the RDS master credentials from Secrets Manager."
  policy      = data.aws_iam_policy_document.db_secret_read.json

  tags = {
    Name = "${var.project}-${var.environment}-db-secret-read-policy"
  }
}
