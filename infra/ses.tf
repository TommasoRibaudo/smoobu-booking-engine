##############################################################################
# ses.tf - SES domain identity and Lambda send-email permissions.
#
# SES supports the transactional booking messages defined in plan.md:
#   - PayPal booking confirmation
#   - Hold expiring reminders
#   - Manual deposit/contact handoff messages
#
# DNS records are optional because hosted DNS may live outside this AWS account.
# If var.ses_route53_zone_id is set, Terraform creates verification, DKIM, and
# MAIL FROM records automatically. Otherwise the output values are used for
# manual DNS setup.
##############################################################################

##############################################################################
# REGION MIGRATION PRE-FLIGHT CHECKLIST (us-east-1 → us-east-2)
#
# SES and ACM are region-scoped services. Before migrating to us-east-2:
#
# 1. REQUEST SES PRODUCTION ACCESS in us-east-2 (24-48h lead time):
#    aws ses put-account-sending-attributes --sending-enabled --region us-east-2
#    If the account is sandboxed in us-east-2, submit a production access request
#    via the AWS console (SES → Account dashboard → Request production access).
#    Do NOT proceed with migration until SES is out of sandbox in us-east-2.
#
# 2. CREATE SES DOMAIN IDENTITY in us-east-2:
#    The aws_ses_domain_identity and aws_ses_domain_dkim resources below will
#    be provisioned in us-east-2 once aws_region = "us-east-2" is set in tfvars.
#    After terraform apply, add the new DKIM and verification DNS records.
#
# 3. VERIFY DKIM SIGNING in us-east-2:
#    Send a test email via the SES console in us-east-2 to confirm DKIM works.
#    Check email headers for DKIM-Signature with d=<your-domain>.
#
# 4. IF USING CUSTOM DOMAIN ON API GATEWAY:
#    Issue a new ACM certificate in us-east-2 before migration.
#    ACM certificates are region-scoped and cannot be transferred between regions.
#    aws acm request-certificate --domain-name api.<domain> --region us-east-2
#
# 5. DO NOT PROCEED with migration until:
#    - SES is verified and out of sandbox in us-east-2
#    - DKIM signing is confirmed working
#    - ACM certificate (if needed) is issued and validated in us-east-2
##############################################################################

locals {
  ses_domain_name = coalesce(var.ses_domain_name, var.domain_name)
  ses_from_email  = coalesce(var.ses_from_email, "reservations@${local.ses_domain_name}")
  ses_mail_from   = "mail.${local.ses_domain_name}"
}

resource "aws_ses_domain_identity" "booking" {
  domain = local.ses_domain_name
}

resource "aws_ses_domain_dkim" "booking" {
  domain = aws_ses_domain_identity.booking.domain
}

resource "aws_ses_domain_mail_from" "booking" {
  domain           = aws_ses_domain_identity.booking.domain
  mail_from_domain = local.ses_mail_from

  behavior_on_mx_failure = "UseDefaultValue"
}

resource "aws_route53_record" "ses_verification" {
  count = var.ses_route53_zone_id != null ? 1 : 0

  zone_id = var.ses_route53_zone_id
  name    = "_amazonses.${local.ses_domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.booking.verification_token]
}

resource "aws_route53_record" "ses_dkim" {
  count = var.ses_route53_zone_id != null ? 3 : 0

  zone_id = var.ses_route53_zone_id
  name    = "${aws_ses_domain_dkim.booking.dkim_tokens[count.index]}._domainkey.${local.ses_domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.booking.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_mx" {
  count = var.ses_route53_zone_id != null ? 1 : 0

  zone_id = var.ses_route53_zone_id
  name    = local.ses_mail_from
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.${var.aws_region}.amazonses.com"]
}

resource "aws_route53_record" "ses_mail_from_txt" {
  count = var.ses_route53_zone_id != null ? 1 : 0

  zone_id = var.ses_route53_zone_id
  name    = local.ses_mail_from
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com -all"]
}

resource "aws_ses_configuration_set" "booking" {
  name = "${var.project}-${var.environment}-booking-email"
}

data "aws_iam_policy_document" "lambda_ses_send" {
  statement {
    sid    = "AllowSendBookingEmail"
    effect = "Allow"

    actions = [
      "ses:SendEmail",
      "ses:SendRawEmail",
    ]

    # While the SES account is sandboxed, SES requires ses:SendEmail
    # authorization against BOTH the sender's identity and every recipient's
    # identity (each guest/staff address must itself be a verified identity).
    # Scoping resources to only the sending domain identity works for the
    # sender half but 403s on the recipient half for every sandboxed send.
    # SendEmail calls also pass ConfigurationSetName, which SES authorizes as
    # its own resource — hence the second ARN below. The ses:FromAddress
    # condition is what actually constrains this policy to the configured
    # ses_from_email, so widening the resource scope does not grant any
    # broader sending capability.
    resources = [
      "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:identity/*",
      "arn:aws:ses:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:configuration-set/${aws_ses_configuration_set.booking.name}",
    ]

    condition {
      test     = "StringEquals"
      variable = "ses:FromAddress"
      values   = [local.ses_from_email]
    }
  }
}

resource "aws_iam_policy" "lambda_ses_send" {
  name        = "${var.project}-${var.environment}-lambda-ses-send"
  description = "Allows booking Lambda functions to send transactional email through SES."
  policy      = data.aws_iam_policy_document.lambda_ses_send.json

  tags = {
    Name = "${var.project}-${var.environment}-lambda-ses-send-policy"
  }
}

resource "aws_iam_role_policy_attachment" "lambda_ses_send" {
  role       = aws_iam_role.lambda_exec.name
  policy_arn = aws_iam_policy.lambda_ses_send.arn
}
