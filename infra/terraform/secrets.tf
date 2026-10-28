# App secrets live in Secrets Manager and are injected into tasks as env vars (§12: env vars only).
# Values Terraform can't know (FCM key, Sentry DSN, provider credentials) are set later in the console/CLI;
# Terraform ignores later changes to them.

resource "random_password" "jwt_access" {
  length  = 64
  special = false
}

resource "random_password" "jwt_refresh" {
  length  = 64
  special = false
}

resource "random_password" "webhook" {
  length  = 48
  special = false
}

locals {
  database_url = "postgresql://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/${aws_db_instance.main.db_name}?schema=public&sslmode=require&connection_limit=10"
  redis_url    = "rediss://:${random_password.redis.result}@${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
  generated_secrets = {
    DATABASE_URL                  = local.database_url
    REDIS_URL                     = local.redis_url
    JWT_ACCESS_SECRET             = random_password.jwt_access.result
    JWT_REFRESH_SECRET            = random_password.jwt_refresh.result
    MOCK_CELLMONEY_WEBHOOK_SECRET = random_password.webhook.result
  }
  # Filled in after apply (aws secretsmanager put-secret-value ...).
  external_secrets = [
    "FCM_SERVICE_ACCOUNT_B64", "SENTRY_DSN", "SEED_ADMIN_PASSWORD",
    # Meta WhatsApp Cloud API (sign-in codes); see docs/whatsapp-otp.md
    "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN",
  ]
}

resource "aws_secretsmanager_secret" "generated" {
  for_each                = local.generated_secrets
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each      = local.generated_secrets
  secret_id     = aws_secretsmanager_secret.generated[each.key].id
  secret_string = each.value
}

resource "aws_secretsmanager_secret" "external" {
  for_each                = toset(local.external_secrets)
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "external" {
  for_each      = toset(local.external_secrets)
  secret_id     = aws_secretsmanager_secret.external[each.key].id
  secret_string = " " # placeholder; set the real value out of band
  lifecycle {
    ignore_changes = [secret_string]
  }
}
