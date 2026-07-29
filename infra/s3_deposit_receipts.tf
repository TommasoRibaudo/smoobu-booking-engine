##############################################################################
# Deposit receipt uploads
#
# Guests paying by bank transfer or SINPE upload proof of payment. The browser
# PUTs directly to S3 using a presigned URL minted by the booking API, so the
# file never passes through Lambda.
#
# The bucket is private in every respect: no public access, TLS required, and
# reads only ever happen through presigned GET URLs that expire.
##############################################################################

locals {
  deposit_receipts_bucket_name = "${var.project}-${var.environment}-deposit-receipts-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket" "deposit_receipts" {
  bucket = local.deposit_receipts_bucket_name

  tags = {
    Name    = local.deposit_receipts_bucket_name
    Purpose = "deposit-receipt-uploads"
  }
}

resource "aws_s3_bucket_public_access_block" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# SSE-S3 rather than KMS on purpose: with a KMS key the browser must send
# matching SSE headers on the presigned PUT or S3 rejects it, and the Lambda role
# would additionally need kms:GenerateDataKey. AES256 keeps presigning simple and
# still encrypts at rest.
resource "aws_s3_bucket_server_side_encryption_configuration" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id

  rule {
    id     = "expire-receipts"
    status = "Enabled"

    filter {
      prefix = "deposit-receipts/"
    }

    expiration {
      days = var.deposit_receipt_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Required: the guest's browser PUTs straight to S3 from the booking site, which
# is a cross-origin request. Without this the upload fails at the preflight.
resource "aws_s3_bucket_cors_configuration" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = split(",", var.booking_api_allowed_origins)
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

data "aws_iam_policy_document" "deposit_receipts_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.deposit_receipts.arn,
      "${aws_s3_bucket.deposit_receipts.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "deposit_receipts" {
  bucket = aws_s3_bucket.deposit_receipts.id
  policy = data.aws_iam_policy_document.deposit_receipts_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.deposit_receipts]
}

##############################################################################
# Lambda access
#
# Presigning makes no API call, but the URL is only valid if the identity that
# signed it holds the permission — so PutObject is required even though Lambda
# never uploads. GetObject covers the HeadObject existence check and the
# presigned download links sent to staff.
##############################################################################

data "aws_iam_policy_document" "lambda_deposit_receipts" {
  statement {
    sid    = "AllowDepositReceiptObjectAccess"
    effect = "Allow"

    actions = [
      "s3:PutObject",
      "s3:GetObject",
    ]

    resources = ["${aws_s3_bucket.deposit_receipts.arn}/deposit-receipts/*"]
  }
}

resource "aws_iam_policy" "lambda_deposit_receipts" {
  name        = "${var.project}-${var.environment}-lambda-deposit-receipts"
  description = "Allows the booking API to presign and verify deposit receipt uploads."
  policy      = data.aws_iam_policy_document.lambda_deposit_receipts.json

  tags = {
    Name = "${var.project}-${var.environment}-lambda-deposit-receipts-policy"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_deposit_receipts" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_deposit_receipts.arn
}

##############################################################################
# S3 gateway endpoint
#
# booking_api runs in private subnets with egress via NAT, so every S3 call
# would otherwise cross the NAT and be billed per GB. A gateway endpoint routes
# it inside the VPC at no cost. Gateway endpoints attach to route tables, not
# subnets, and carry no hourly charge.
##############################################################################

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${data.aws_region.current.name}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = [aws_route_table.private.id]

  tags = {
    Name = "${var.project}-${var.environment}-s3-endpoint"
  }
}
