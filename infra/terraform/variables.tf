variable "region" {
  description = "AWS region. Sydney (ap-southeast-2) is the lowest-latency AWS region to Port Moresby. [CONFIRM]"
  type        = string
  default     = "ap-southeast-2"
}

variable "environment" {
  description = "Environment name (prod, staging)."
  type        = string
  default     = "prod"
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "api_domain" {
  description = "Public hostname for the API, e.g. api.cooperwaters.com.pg. Empty = use the ALB DNS name over HTTP only (testing)."
  type        = string
  default     = ""
}

variable "api_certificate_arn" {
  description = "ACM certificate ARN (in var.region) for api_domain. Required when api_domain is set."
  type        = string
  default     = ""
}

variable "admin_domain" {
  description = "Hostname for the admin dashboard, e.g. admin.cooperwaters.com.pg. Empty = CloudFront default domain."
  type        = string
  default     = ""
}

variable "admin_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for admin_domain (CloudFront requirement)."
  type        = string
  default     = ""
}

variable "api_image_tag" {
  description = "Image tag to run. CI deploys by registering new task definitions; this is the initial tag."
  type        = string
  default     = "latest"
}

variable "api_cpu" {
  type    = number
  default = 512
}

variable "api_memory" {
  type    = number
  default = 1024
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 6
}

variable "worker_desired_count" {
  type    = number
  default = 1
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 50
}

variable "db_multi_az" {
  description = "Multi-AZ RDS (recommended for production)."
  type        = bool
  default     = true
}

variable "db_backup_retention_days" {
  description = "Daily automated backups retention (§12: 30 days). [CONFIRM]"
  type        = number
  default     = 30
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "redis_multi_az" {
  description = "Two Redis nodes across availability zones with automatic failover. false = one node (cheaper, for staging)."
  type        = bool
  default     = true
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "sms_provider" {
  description = "SMS adapter (mock until the PNG SMS gateway is chosen). [CONFIRM]"
  type        = string
  default     = "mock"
}

variable "push_provider" {
  type    = string
  default = "mock"
}

variable "github_repository" {
  description = "owner/repo allowed to deploy via GitHub Actions OIDC. Empty = don't create the deploy role."
  type        = string
  default     = ""
}

variable "github_oidc_subject_prefix" {
  description = <<-EOT
    Extra OIDC subject prefix to trust, for repos that use GitHub's immutable subject format
    (e.g. "repo:owner@123/repo@456"). Get it with:
    gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix
  EOT
  type        = string
  default     = ""
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC identity provider (only one per AWS account)."
  type        = bool
  default     = true
}

variable "alarm_email" {
  description = "Email for CloudWatch alarms. Empty = no alarm notifications."
  type        = string
  default     = ""
}

variable "enable_db_tunnel" {
  description = "Create a tiny private EC2 instance for Session Manager port forwarding to the database (scripts/db-tunnel.sh). ~US$4/month."
  type        = bool
  default     = false
}
