# Booking Engine — Infrastructure

Terraform module for the AWS side of the [Smoobu Booking Engine](../README.md).
See [../AGENTS.md](../AGENTS.md) for the full integration guide.

## What this provisions

VPC (public/app/data subnets, NAT via [fck-nat](https://github.com/AndrewGuenther/fck-nat)),
RDS PostgreSQL, five Lambda functions (booking API, webhooks, hold-expiry
worker, payment-reconciliation worker, migration runner), API Gateway, Secrets
Manager entries, an S3 bucket for deposit receipts, SES, CloudWatch
alarms/dashboard, WAF, and an optional CloudFront-fronted S3 bucket for a
static frontend.

## Usage

```bash
# 1. Bootstrap the state bucket/table once — see the comment block at the
#    top of main.tf for the exact AWS CLI commands.

cp environments/example.tfvars environments/dev.tfvars   # fill in real values
cp backend.hcl.example backend-dev.hcl                    # fill in real values, never commit

terraform init -backend-config=backend-dev.hcl
terraform plan  -var-file=environments/dev.tfvars
terraform apply -var-file=environments/dev.tfvars
```

`environments/*.tfvars` and `backend*.hcl` are gitignored — they describe
your VPC/subnet layout and Secrets Manager paths, which is reconnaissance
material for a public repo even though no actual credential lives in them.

## Naming

Every resource is named `${var.project}-${var.environment}-*`. Set `project`
in your `.tfvars` once; nothing else needs to change per deployment.

## Secrets

This module creates empty Secrets Manager entries (`smoobu_secret_name`,
`paypal_secret_name`, `db_secret_name`, `webhook_secret_name`,
`encryption_secret_name`, or the combined `booking_api_secret_name`) — it does
not populate them. Fill in real values through the AWS Console or CLI after
`apply`, never through Terraform state.
