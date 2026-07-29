##############################################################################
# main.tf — AWS provider configuration and remote state backend
#
# Environments are separated via .tfvars files in environments/.
# Run:
#   terraform init
#   terraform plan  -var-file=environments/dev.tfvars
#   terraform apply -var-file=environments/dev.tfvars
##############################################################################

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # ---------------------------------------------------------------------------
  # Remote state backend: S3 bucket for state file + DynamoDB table for locking.
  #
  # Bootstrap before first init:
  #   aws s3api create-bucket \
  #     --bucket myproject-tfstate-<account-id> \
  #     --region us-east-1 \
  #     --create-bucket-configuration LocationConstraint=us-east-1
  #   aws s3api put-bucket-versioning \
  #     --bucket myproject-tfstate-<account-id> \
  #     --versioning-configuration Status=Enabled
  #   aws s3api put-bucket-encryption \
  #     --bucket myproject-tfstate-<account-id> \
  #     --server-side-encryption-configuration \
  #       '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  #   aws dynamodb create-table \
  #     --table-name myproject-tfstate-lock \
  #     --attribute-definitions AttributeName=LockID,AttributeType=S \
  #     --key-schema AttributeName=LockID,KeyType=HASH \
  #     --billing-mode PAY_PER_REQUEST \
  #     --region us-east-1
  # ---------------------------------------------------------------------------
  backend "s3" {
    # Override bucket/key/region with -backend-config flags or a backend.hcl
    # file when running across environments so a single state file is never
    # shared between dev/staging/prod. See backend.hcl.example.
    #
    # Example backend.hcl (not committed — differs per environment):
    #   bucket         = "myproject-tfstate-<account-id>"
    #   key            = "booking-engine/dev/terraform.tfstate"
    #   region         = "us-east-1"
    #   dynamodb_table = "myproject-tfstate-lock"
    #   encrypt        = true
  }
}

##############################################################################
# AWS provider
##############################################################################

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
