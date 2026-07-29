##############################################################################
# frontend.tf - Optional S3 + CloudFront hosting for the React frontend.
#
# Scope for task 2.9:
#   - Private S3 bucket for compiled CRA build artifacts only.
#   - CloudFront distribution with Origin Access Control (OAC) so the bucket
#     is never public.
#   - SPA fallback to /index.html for client-side React routes.
#   - No custom receipt-upload storage, pre-signed upload flow, or public
#     deposit-proof objects are provisioned in the MVP.
#
# The existing FTPS/cPanel frontend pipeline can remain in place until DNS and
# CI/CD are intentionally moved to this distribution in later tasks.
##############################################################################

locals {
  frontend_bucket_name = var.frontend_bucket_name != null ? var.frontend_bucket_name : "${var.project}-${var.environment}-frontend-${data.aws_caller_identity.current.account_id}"
  frontend_origin_id   = "${var.project}-${var.environment}-frontend-s3"
}

##############################################################################
# S3 origin - private frontend build artifact bucket
##############################################################################

resource "aws_s3_bucket" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = local.frontend_bucket_name

  tags = {
    Name    = local.frontend_bucket_name
    Purpose = "frontend-static-assets"
  }
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = aws_s3_bucket.frontend[0].id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = aws_s3_bucket.frontend[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = aws_s3_bucket.frontend[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = aws_s3_bucket.frontend[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = aws_s3_bucket.frontend[0].id

  rule {
    id     = "expire-old-frontend-builds"
    status = "Enabled"

    filter {
      prefix = ""
    }

    noncurrent_version_expiration {
      noncurrent_days = var.environment == "prod" ? 90 : 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.frontend]
}

##############################################################################
# CloudFront distribution
##############################################################################

resource "aws_cloudfront_origin_access_control" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  name                              = "${var.project}-${var.environment}-frontend-oac"
  description                       = "OAC for the private frontend S3 origin."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_cache_policy" "frontend_spa" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  name        = "${var.project}-${var.environment}-frontend-spa"
  comment     = "Short cache policy for SPA HTML and route fallback responses."
  default_ttl = 300
  max_ttl     = 3600
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_cache_policy" "frontend_static_assets" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  name        = "${var.project}-${var.environment}-frontend-static-assets"
  comment     = "Long cache policy for hashed CRA static assets."
  default_ttl = 31536000
  max_ttl     = 31536000
  min_ttl     = 0

  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }

    headers_config {
      header_behavior = "none"
    }

    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

resource "aws_cloudfront_response_headers_policy" "frontend_security" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  name    = "${var.project}-${var.environment}-frontend-security"
  comment = "Baseline security headers for frontend assets."

  security_headers_config {
    content_type_options {
      override = true
    }

    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
      preload                    = false
    }

    xss_protection {
      mode_block = true
      override   = true
      protection = true
    }
  }
}

resource "aws_cloudfront_distribution" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  enabled             = true
  is_ipv6_enabled     = true
  comment             = "${var.environment} React frontend CDN."
  default_root_object = "index.html"
  price_class         = var.frontend_cdn_price_class
  aliases             = var.frontend_cdn_aliases
  http_version        = "http2and3"

  origin {
    domain_name              = aws_s3_bucket.frontend[0].bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend[0].id
    origin_id                = local.frontend_origin_id
  }

  default_cache_behavior {
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = aws_cloudfront_cache_policy.frontend_spa[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
  }

  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = local.frontend_origin_id
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = aws_cloudfront_cache_policy.frontend_static_assets[0].id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    # AWS requires TLSv1 when using CloudFront's default *.cloudfront.net
    # certificate. Custom aliases should supply an ACM cert and use TLSv1.2_2021.
    acm_certificate_arn            = length(var.frontend_cdn_aliases) > 0 ? var.frontend_cdn_acm_certificate_arn : null
    cloudfront_default_certificate = length(var.frontend_cdn_aliases) == 0
    minimum_protocol_version       = length(var.frontend_cdn_aliases) > 0 ? "TLSv1.2_2021" : "TLSv1"
    ssl_support_method             = length(var.frontend_cdn_aliases) > 0 ? "sni-only" : null
  }

  tags = {
    Name = "${var.project}-${var.environment}-frontend-cdn"
  }

  lifecycle {
    precondition {
      condition     = length(var.frontend_cdn_aliases) == 0 || var.frontend_cdn_acm_certificate_arn != null
      error_message = "frontend_cdn_acm_certificate_arn is required when frontend_cdn_aliases is non-empty."
    }
  }
}

##############################################################################
# Bucket policy - CloudFront is the only public read path
##############################################################################

data "aws_iam_policy_document" "frontend_bucket_read" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  statement {
    sid    = "AllowCloudFrontReadOnly"
    effect = "Allow"

    actions = ["s3:GetObject"]

    resources = [
      "${aws_s3_bucket.frontend[0].arn}/*",
    ]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend[0].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend" {
  count = var.frontend_static_hosting_enabled ? 1 : 0

  bucket = aws_s3_bucket.frontend[0].id
  policy = data.aws_iam_policy_document.frontend_bucket_read[0].json

  depends_on = [aws_s3_bucket_public_access_block.frontend]
}
