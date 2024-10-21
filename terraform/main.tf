provider "aws" {
  region = "ap-northeast-1"
  profile = var.aws_profile
}

# Provider for us-east-1 region (required for CloudFront certificate)
provider "aws" {
  alias  = "us-east-1"
  region = "us-east-1"
  profile = var.aws_profile
}

# Variables
variable "aws_profile" {
  type = string
}

variable "subdomain" {
  type = string
}

variable "domain_name" {
  type = string
}

variable "rds_username" {
  type = string
}

variable "rds_password" {
  type = string
}

locals {
  full_domain_name = "${var.subdomain}.${var.domain_name}"
}

# Data sources
data "aws_route53_zone" "hosted_zone" {
  name = var.domain_name
}

# VPC
resource "aws_vpc" "my_vpc" {
  cidr_block = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true
}

# Subnets
resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.my_vpc.id
  cidr_block        = "10.0.${count.index}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]
}

resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.my_vpc.id
  cidr_block        = "10.0.${count.index + 10}.0/24"
  availability_zone = data.aws_availability_zones.available.names[count.index]
}

# Security Groups
resource "aws_security_group" "alb_sg" {
  name        = "ALBSecurityGroup"
  vpc_id      = aws_vpc.my_vpc.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "web_server_sg" {
  name        = "WebServerSecurityGroup"
  vpc_id      = aws_vpc.my_vpc.id

  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  ingress {
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.alb_sg.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds_sg" {
  name        = "RDSSecurityGroup"
  vpc_id      = aws_vpc.my_vpc.id

  ingress {
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.web_server_sg.id]
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.my_vpc.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.my_vpc.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# RDS Instance
resource "aws_db_instance" "rds_instance" {
  engine            = "mysql"
  engine_version    = "8.0"
  instance_class    = "db.t3.micro"
  allocated_storage = 20
  multi_az          = true
  backup_retention_period = 0
  deletion_protection = true
  skip_final_snapshot = true
  username          = var.rds_username  # RDSインスタンスのユーザー名
  password          = var.rds_password

  vpc_security_group_ids = [aws_security_group.rds_sg.id]
  db_subnet_group_name   = aws_db_subnet_group.private.name
}

resource "aws_db_subnet_group" "private" {
  name       = "private"
  subnet_ids = aws_subnet.private[*].id
}

# Launch Template
resource "aws_launch_template" "web_server" {
  name_prefix   = "web-server-"
  instance_type = "t3.micro"
  image_id      = data.aws_ami.amazon_linux_2.id

  network_interfaces {
    security_groups = [aws_security_group.web_server_sg.id]
  }
}

# Auto Scaling Group
resource "aws_autoscaling_group" "web_server_asg" {
  vpc_zone_identifier = aws_subnet.public[*].id
  desired_capacity    = 2
  min_size            = 1
  max_size            = 3

  launch_template {
    id      = aws_launch_template.web_server.id
    version = "$Latest"
  }

  target_group_arns = [aws_lb_target_group.web_server.arn]
}

# Auto Scaling Policy
resource "aws_autoscaling_policy" "web_server_policy" {
  name                   = "KeepCPUUtilizationAroundSeventy"
  policy_type            = "TargetTrackingScaling"
  autoscaling_group_name = aws_autoscaling_group.web_server_asg.name

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = 70.0
  }
}

# ALB Certificate
resource "aws_acm_certificate" "alb_cert" {
  domain_name       = local.full_domain_name
  validation_method = "DNS"
}

# Application Load Balancer
resource "aws_lb" "web_server_alb" {
  name               = "WebServerALB"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb_sg.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.web_server_alb.arn
  port              = "80"
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.web_server_alb.arn
  port              = "443"
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-2016-08"
  certificate_arn   = aws_acm_certificate.alb_cert.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web_server.arn
  }
}

resource "aws_lb_target_group" "web_server" {
  port     = 80
  protocol = "HTTP"
  vpc_id   = aws_vpc.my_vpc.id

  health_check {
    path = "/"
  }
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "web_distribution" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [local.full_domain_name]

  origin {
    domain_name = aws_lb.web_server_alb.dns_name
    origin_id   = "ALB"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "ALB"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  viewer_certificate {
    acm_certificate_arn = aws_acm_certificate.cloudfront_cert.arn
    ssl_support_method  = "sni-only"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# CloudFront Certificate
resource "aws_acm_certificate" "cloudfront_cert" {
  provider          = aws.us-east-1
  domain_name       =  local.full_domain_name
  validation_method = "DNS"
}

# Route 53 Record
resource "aws_route53_record" "www" {
  zone_id = data.aws_route53_zone.hosted_zone.zone_id
  name    = var.subdomain
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.web_distribution.domain_name
    zone_id                = aws_cloudfront_distribution.web_distribution.hosted_zone_id
    evaluate_target_health = false
  }
}

# Outputs
output "domain_name" {
  value = local.full_domain_name
}

output "distribution_domain_name" {
  value = aws_cloudfront_distribution.web_distribution.domain_name
}

# Data sources
data "aws_availability_zones" "available" {}

data "aws_ami" "amazon_linux_2" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }
}
