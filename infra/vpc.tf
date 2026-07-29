##############################################################################
# vpc.tf — VPC, subnets, internet gateway, NAT, route tables, and security
#          groups for Lambda and RDS.
#
# Subnet layout (defaults from variables.tf, override per environment):
#   Public   var.public_subnet_cidrs — NAT, internet-facing
#   App      var.app_subnet_cidrs    — Lambda functions
#   Data     var.data_subnet_cidrs   — RDS
#
# App and data are separate tiers so database access is constrained by subnet
# as well as by security group.
##############################################################################

##############################################################################
# VPC
##############################################################################

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # Required for RDS endpoint hostname resolution.

  tags = {
    Name = "${var.project}-${var.environment}-vpc"
  }
}

##############################################################################
# Internet gateway (public-subnet egress / ingress)
##############################################################################

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project}-${var.environment}-igw"
  }
}

##############################################################################
# Subnets
##############################################################################

# Public subnets — one per AZ.
# Used for: NAT gateway, future ALB/CloudFront origin if needed.
# Instances launched here get public IPs; Lambda runs in private subnets.
resource "aws_subnet" "public" {
  count = length(var.availability_zones)

  vpc_id                  = aws_vpc.main.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project}-${var.environment}-public-${count.index + 1}"
    Tier = "public"
  }
}

# Private subnets — one per AZ.
# Used for: Lambda functions (app tier).
# No direct inbound from internet; outbound via NAT gateway.
resource "aws_subnet" "private" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.app_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "${var.project}-${var.environment}-app-${count.index + 1}"
    Tier = "app"
  }
}

# Data subnets — one per AZ.
# Used for: RDS PostgreSQL.
# Separate from app subnets to enforce network segmentation between
# application and data tiers (Req 8.3, 8.4).
resource "aws_subnet" "data" {
  count = length(var.availability_zones)

  vpc_id            = aws_vpc.main.id
  cidr_block        = var.data_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name = "${var.project}-${var.environment}-data-${count.index + 1}"
    Tier = "data"
  }
}

##############################################################################
# NAT gateway (single instance in first public subnet)
#
# A single NAT gateway is sufficient for dev/staging and keeps costs low.
# For production HA: provision one NAT GW per AZ and one private route table
# per AZ, each pointing at the local AZ's NAT gateway.
#
# nat_gateway_type = "managed" → AWS-managed NAT Gateway (~$32/month)
# nat_gateway_type = "fck-nat" → fck-nat t4g.nano EC2 instance (~$3/month)
##############################################################################

# fck-nat AMI — resolved only when nat_gateway_type = "fck-nat"
data "aws_ami" "fck_nat" {
  count       = var.nat_gateway_type == "fck-nat" ? 1 : 0
  most_recent = true
  owners      = ["568608671756"]

  filter {
    name   = "name"
    values = ["fck-nat-al2023-*"]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway_type == "managed" ? 1 : 0
  domain = "vpc"

  # EIP must be requested after the IGW is attached so AWS can route it.
  depends_on = [aws_internet_gateway.main]

  tags = {
    Name = "${var.project}-${var.environment}-nat-eip"
  }
}

resource "aws_nat_gateway" "main" {
  count         = var.nat_gateway_type == "managed" ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id

  depends_on = [aws_internet_gateway.main]

  tags = {
    Name = "${var.project}-${var.environment}-natgw"
  }
}

##############################################################################
# Route tables
##############################################################################

# Public route table: default route → internet gateway.
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name = "${var.project}-${var.environment}-rt-public"
  }
}

# Private route table: default route managed by a separate aws_route resource
# (see task 5.4) to avoid conflicts between managed NAT and fck-nat modes.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name = "${var.project}-${var.environment}-rt-private"
  }
}

# Associate each public subnet with the public route table.
resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Associate each app subnet with the private route table.
resource "aws_route_table_association" "private" {
  count = length(aws_subnet.private)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Associate each data subnet with the private route table.
# Data subnets share the same outbound route (NAT) as app subnets but are
# in separate CIDRs to enforce network segmentation.
resource "aws_route_table_association" "data" {
  count = length(aws_subnet.data)

  subnet_id      = aws_subnet.data[count.index].id
  route_table_id = aws_route_table.private.id
}

# Default route for private subnets — managed NAT Gateway mode.
# Created only when nat_gateway_type = "managed".
resource "aws_route" "private_nat_managed" {
  count                  = var.nat_gateway_type == "managed" ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  nat_gateway_id         = aws_nat_gateway.main[0].id
}

# Default route for private subnets — fck-nat mode.
# Terraform creates the route entry; fck-nat replaces the target on every boot
# via ec2:ReplaceRoute (using the IAM policy from task 5.2). The initial target
# is the IGW as a placeholder — fck-nat will replace it with the actual instance
# ENI on first boot. lifecycle.ignore_changes prevents Terraform from fighting
# fck-nat over the route target on subsequent applies.
resource "aws_route" "private_nat_fck" {
  count                  = var.nat_gateway_type == "fck-nat" ? 1 : 0
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  # Placeholder target: fck-nat will replace this with the actual instance ENI
  # on first boot via ec2:ReplaceRoute. The IGW is used here only so Terraform
  # can create a valid route entry; it is never used for actual NAT traffic.
  gateway_id = aws_internet_gateway.main.id

  lifecycle {
    # fck-nat manages the actual route target (network_interface_id) after the
    # initial apply via ec2:ReplaceRoute. Ignoring changes here prevents
    # Terraform from reverting fck-nat's route updates on subsequent applies.
    ignore_changes = [gateway_id, network_interface_id]
  }

  depends_on = [aws_autoscaling_group.fck_nat]
}

##############################################################################
# Security groups
##############################################################################

# ---------------------------------------------------------------------------
# Lambda security group
#
# Inbound: no rules — API Gateway invokes Lambda via IAM, not over the
#          network directly (HTTP API + Lambda integration uses AWS internal
#          routing, not VPC ingress). HTTPS from the public internet never
#          reaches the Lambda SG inbound.
# Outbound: unrestricted — Lambda must reach:
#   • Smoobu REST API (api.smoobu.com, HTTPS/443)
#   • PayPal REST API (api.paypal.com, HTTPS/443)
#   • AWS services (Secrets Manager, SES, CloudWatch) via VPC endpoints or NAT
# ---------------------------------------------------------------------------
resource "aws_security_group" "lambda" {
  name_prefix = "${var.project}-${var.environment}-lambda-"
  description = "Booking API Lambda functions: outbound-only to internet + AWS services."
  vpc_id      = aws_vpc.main.id

  egress {
    description = "Allow all outbound (Smoobu, PayPal, AWS APIs)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-${var.environment}-sg-lambda"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# RDS security group
#
# Inbound:  PostgreSQL (5432) from Lambda SG only.
# Outbound: none needed (RDS never initiates connections).
# ---------------------------------------------------------------------------
resource "aws_security_group" "rds" {
  name_prefix = "${var.project}-${var.environment}-rds-"
  description = "RDS PostgreSQL: accept connections from Lambda SG only."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "PostgreSQL from Lambda."
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda.id]
  }

  tags = {
    Name = "${var.project}-${var.environment}-sg-rds"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# fck-nat security group
# ---------------------------------------------------------------------------
resource "aws_security_group" "fck_nat" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  name_prefix = "${var.project}-${var.environment}-fck-nat-"
  description = "fck-nat instance: allow all outbound, inbound only from VPC CIDR."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Allow all inbound from VPC (traffic to be NATted)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    description = "Allow all outbound (internet egress for NATted traffic)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.project}-${var.environment}-sg-fck-nat"
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---------------------------------------------------------------------------
# fck-nat IAM role and instance profile
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "fck_nat_assume_role" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  statement {
    sid     = "AllowEC2AssumeRole"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "fck_nat" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  name               = "${var.project}-${var.environment}-fck-nat"
  description        = "Allows the fck-nat EC2 instance to self-configure EIP association and route table updates."
  assume_role_policy = data.aws_iam_policy_document.fck_nat_assume_role[0].json

  tags = {
    Name = "${var.project}-${var.environment}-fck-nat-role"
  }
}

resource "aws_iam_instance_profile" "fck_nat" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  name = "${var.project}-${var.environment}-fck-nat"
  role = aws_iam_role.fck_nat[0].name

  tags = {
    Name = "${var.project}-${var.environment}-fck-nat-instance-profile"
  }
}

data "aws_iam_policy_document" "fck_nat_self_configure" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  statement {
    sid    = "FckNatSelfConfigure"
    effect = "Allow"

    actions = [
      "ec2:AssociateAddress",
      "ec2:ReplaceRoute",
      "ec2:ModifyInstanceAttribute",
    ]

    # Scoped to resources tagged with this project to limit blast radius.
    # The provider's default_tags block stamps Project = var.project onto the
    # EIP and route table, and the launch template tag_specifications block
    # stamps it onto the instance, so all three targets match this condition.
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/Project"
      values   = [var.project]
    }
  }

  # Describe* actions do NOT support resource-level permissions or
  # aws:ResourceTag conditions — a conditioned statement denies them outright.
  # They must be granted separately on "*" with no condition. fck-nat calls
  # these on boot to resolve its own ENI, the EIP allocation, and the route
  # table before it can call AssociateAddress / ReplaceRoute.
  statement {
    sid    = "FckNatDescribe"
    effect = "Allow"

    actions = [
      "ec2:DescribeAddresses",
      "ec2:DescribeInstances",
      "ec2:DescribeNetworkInterfaces",
      "ec2:DescribeRouteTables",
      "ec2:DescribeSubnets",
    ]

    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "fck_nat_self_configure" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  name   = "fck-nat-self-configure"
  role   = aws_iam_role.fck_nat[0].id
  policy = data.aws_iam_policy_document.fck_nat_self_configure[0].json
}

# Session Manager access. The instance has no inbound SSH and sits behind no
# bastion, so without this there is no way to read its logs and diagnose a
# failed boot. Also makes the instance usable as the SSM bastion for RDS port
# forwarding (see MIGRATION_RUNBOOK.md).
resource "aws_iam_role_policy_attachment" "fck_nat_ssm" {
  count = var.nat_gateway_type == "fck-nat" ? 1 : 0

  role       = aws_iam_role.fck_nat[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ---------------------------------------------------------------------------
# fck-nat EIP, launch template, and Auto Scaling Group
# ---------------------------------------------------------------------------

resource "aws_eip" "fck_nat" {
  count      = var.nat_gateway_type == "fck-nat" ? 1 : 0
  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]

  tags = {
    Name = "${var.project}-${var.environment}-fck-nat-eip"
  }
}

resource "aws_launch_template" "fck_nat" {
  count         = var.nat_gateway_type == "fck-nat" ? 1 : 0
  name_prefix   = "${var.project}-${var.environment}-fck-nat-"
  image_id      = data.aws_ami.fck_nat[0].id
  instance_type = "t4g.nano"

  iam_instance_profile {
    name = aws_iam_instance_profile.fck_nat[0].name
  }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.fck_nat[0].id]
    # source_dest_check is disabled by fck-nat on boot via ec2:ModifyInstanceAttribute
    # (the IAM policy grants this permission; the launch template cannot set it directly)
  }

  user_data = base64encode(<<-EOT
    #!/bin/bash
    echo "eip_id=${aws_eip.fck_nat[0].id}" >> /etc/fck-nat.conf
    echo "route_table_id=${aws_route_table.private.id}" >> /etc/fck-nat.conf

    # fck-nat.service starts at boot, before cloud-init runs this script, so it
    # has already read an empty /etc/fck-nat.conf. Without this restart the
    # instance never claims the EIP and never takes over the private route
    # table, and NAT silently does not work.
    service fck-nat restart

    # AL2023 ships the SSM agent enabled, but make it explicit so a failed boot
    # is always diagnosable via Session Manager.
    systemctl enable --now amazon-ssm-agent 2>/dev/null || true
  EOT
  )

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name    = "${var.project}-${var.environment}-fck-nat"
      Project = var.project
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "fck_nat" {
  count               = var.nat_gateway_type == "fck-nat" ? 1 : 0
  name_prefix         = "${var.project}-${var.environment}-fck-nat-"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  vpc_zone_identifier = [aws_subnet.public[0].id]

  launch_template {
    id      = aws_launch_template.fck_nat[0].id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${var.project}-${var.environment}-fck-nat"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
  }
}
