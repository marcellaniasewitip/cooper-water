# Deploying Cooper Waters to AWS

Target: **ap-southeast-2 (Sydney)** — the lowest-latency AWS region to Port Moresby. Everything is in
`infra/terraform`; application rollouts are done by `.github/workflows/deploy.yml`.

## What gets created

| Resource | Notes |
| --- | --- |
| VPC (2 AZs), public + private subnets, NAT, S3 gateway endpoint | Tasks, DB and Redis are private |
| ALB (HTTP→HTTPS, TLS 1.2/1.3, 120 s idle for WebSockets, sticky cookie for Socket.IO polling) | Health check `/health` |
| ECS Fargate: `api` (2–6 tasks, CPU autoscaling) and `worker` (1 task) | One image; deployment circuit breaker with rollback |
| ECS one-off task family `…-migrate` | `prisma migrate deploy`; also used to seed |
| RDS PostgreSQL 16, Multi-AZ, encrypted, forced SSL, 30-day backups, deletion protection | PostGIS is enabled by the first migration |
| ElastiCache Redis 7 (TLS + AUTH, `noeviction`, Multi-AZ) | BullMQ + Socket.IO fan-out |
| S3 uploads bucket (private, versioned, TLS-only) | Presigned PUT/GET only |
| S3 + CloudFront (OAC) for the admin dashboard | SPA fallback, security headers |
| CloudFront in front of the ALB (only while no API domain/certificate is set) | Free HTTPS address for the API; nothing cached |
| ECR repository (scan on push, keep 30 images) | |
| Secrets Manager: DB/Redis URLs, JWT secrets, webhook secret (generated); FCM, Sentry, seed password (fill in) | Injected as env vars |
| CloudWatch logs (30 days) and alarms (5xx, p95 > 300 ms, unhealthy targets, DB CPU, worker down) → SNS | |
| GitHub OIDC deploy role | No long-lived AWS keys in GitHub |

Rough cost at default sizes: ~US$250–350/month (NAT, Multi-AZ RDS and Redis dominate). The example
`terraform.tfvars.example` uses the starter size (~US$130–180/month): `db_multi_az=false`,
`db_instance_class="db.t4g.micro"`, `redis_multi_az=false`, `redis_node_type="cache.t4g.micro"`, `api_desired_count=1`.

**No domain yet?** Leave `api_domain`/`api_certificate_arn` empty. The API is then served through a
CloudFront distribution at a free `https://<id>.cloudfront.net` address (`terraform output api_url`), so the
HTTPS admin dashboard can call it. When you add the domain and certificate later, re-run `terraform apply`
(that distribution is removed), update `API_PUBLIC_URL` in GitHub and redeploy. Build the Play Store
releases of the Android apps only after the final domain is in place, because the API address is built into them.

## First-time setup

1. **Prerequisites**: AWS account + admin credentials locally, Terraform ≥ 1.6, AWS CLI v2, Docker.
   Optional but recommended: ACM certificates for `api.<domain>` (in ap-southeast-2) and `admin.<domain>` (in us-east-1).
2. **State bucket** (once): create an S3 bucket + DynamoDB lock table and uncomment the `backend "s3"` block in
   `infra/terraform/versions.tf`.
3. **Apply**:
   ```bash
   cd infra/terraform
   cp terraform.tfvars.example terraform.tfvars   # edit domains, certificates, github_repository, alarm_email
   terraform init && terraform apply
   ```
4. **Fill external secrets** (names are in `terraform output secrets_to_fill`):
   ```bash
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/SEED_ADMIN_PASSWORD --secret-string '<strong password>'
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/SENTRY_DSN --secret-string 'https://…'      # optional
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/FCM_SERVICE_ACCOUNT_B64 --secret-string "$(base64 -w0 firebase.json)"  # then set push_provider="fcm"
   ```
5. **DNS** (skip until you have a domain): CNAME/alias `api.<domain>` → `terraform output alb_dns_name`; `admin.<domain>` → `cloudfront_domain`.
6. **GitHub configuration** (Settings → Secrets and variables → Actions, environment `production`):
   - secret `AWS_DEPLOY_ROLE_ARN` = `terraform output deploy_role_arn`
   - variables: `AWS_REGION=ap-southeast-2`, `NAME_PREFIX=cooper-waters-prod`, `ECR_REPOSITORY_URL`, `ADMIN_BUCKET`,
     `CLOUDFRONT_DISTRIBUTION_ID`, `API_PUBLIC_URL` (= `terraform output api_url`, e.g. `https://d2xyz.cloudfront.net` or `https://api.cooperwaters.com.pg`),
     `PRIVATE_SUBNET_IDS` (comma-separated, from `private_subnet_ids`), `APP_SECURITY_GROUP_ID`.
7. **Deploy**: push to `main` or run *Deploy to AWS* manually. The first run pushes the image, migrates, and
   starts the services (they crash-loop until the first image exists — that's expected before step 7).
8. **Seed RBAC + admins + templates** (once, no demo data):
   ```bash
   aws ecs run-task --cluster cooper-waters-prod --launch-type FARGATE --task-definition cooper-waters-prod-migrate \
     --network-configuration "awsvpcConfiguration={subnets=[subnet-…],securityGroups=[sg-…]}" \
     --overrides '{"containerOverrides":[{"name":"migrate","command":["node","dist/cli/seed.js"]}]}'
   ```
   Then sign in at the admin URL as `super.admin@cooperwaters.com.pg` with `SEED_ADMIN_PASSWORD`, **turn on
   two-factor sign-in**, create real admin users, and disable/rename the seeded ones.
9. **Business setup in the dashboard**: depots + geofences, packages and prices, commission, minimum balance,
   cell money merchant number, notification templates.
10. **Mobile apps**: build release APKs/AABs with the production base URL (see each app's README) and upload to
    Google Play.

## Before go-live checklist

- [ ] WhatsApp sign-in codes connected (`docs/whatsapp-otp.md`), and `SMS_PROVIDER` is a real gateway for the backup (mock only writes OTPs to logs) — §16 #3
- [ ] Cell money adapter chosen; webhook URL registered with the provider; secrets in Secrets Manager — §16 #1
- [ ] `push_provider = "fcm"` with the Firebase service account
- [ ] HTTPS certificates attached; API reachable only over HTTPS
- [ ] Seeded admin passwords rotated, TOTP on for every admin
- [ ] Alarms subscribed (`alarm_email`) and confirmed
- [ ] Restore drill: restore an RDS snapshot to a scratch instance and run the app against it
- [ ] Load test passes (`infra/loadtest`, p95 < 300 ms)
- [ ] UAT checklist signed off (`docs/uat-checklist.md`)

## Rollback

- Application: ECS circuit breaker rolls back failed deployments automatically. Manual:
  `aws ecs update-service --cluster cooper-waters-prod --service api --task-definition cooper-waters-prod-api:<previous revision>`
  (same for `worker`).
- Database: migrations are forward-only; write a new migration to undo. Point-in-time restore is available for
  the backup retention window.
