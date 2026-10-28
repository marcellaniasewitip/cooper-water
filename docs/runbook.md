# Operations runbook

## Health
- `GET /health` → `{status, checks: {database, redis}}` (503 if a dependency is down). ALB uses it.
- Logs: CloudWatch `/ecs/cooper-waters-prod/api` and `/worker` (structured JSON; search by `orderId`, `paymentId`).
- Shell into a task: `aws ecs execute-command --cluster cooper-waters-prod --task <id> --container api --interactive --command sh`.

## Common situations

| Symptom | What to check / do |
| --- | --- |
| Orders stuck in SEARCHING past expiry | Worker running? (`worker-down` alarm). The sweeper runs every minute and expires them once the worker is back. |
| Cell money payments stuck pending | Admin → Payments: *Recheck* (API adapters) or *Confirm* by matching the order code in the merchant statement (manual adapter). Unmatched payments expire after `payment.cellmoney.timeout_sec` and the order fails. |
| Customer paid after the order failed | Confirm the payment anyway — the system records it and creates a refund automatically (manual adapter: complete it in the Refunds queue after paying back). |
| Webhook errors | Admin → Webhook events shows the raw payload and error; failed processing is retried by the sweeper every 2 min. Bad signatures are stored with `signature_ok = false`. |
| Driver can't go online | `wallet_below_minimum` (top up), `not_at_depot` (must be inside a depot geofence when `depot.online_gated`), or not approved. |
| Driver shows offline unexpectedly | Drivers whose app stops sending location for 10 min are set offline by the sweeper. |
| OTP not arriving | Check ClickSend credit and delivery report (dashboard), and see `docs/sms-clicksend.md`; Notifications table rows with `status=failed` and `last_error`. Per-phone limit is `otp.max_sends_per_phone_per_hour`. |
| Wallet balance looks wrong | Ledger is the source of truth: `SELECT sum(amount_toea) FROM ledger_entries WHERE wallet_id=…` must equal `wallets.balance_toea`. Correct with an *Adjustment* (never edit entries — the DB rejects it). |

## Money reconciliation (daily)
1. Reports → Payments by method for yesterday (Port Moresby day).
2. Match cell money "orders + top-ups" to the merchant account statement; bank top-ups to the bank statement.
3. Refunds queue must be empty or explained; payouts queue processed per the payout schedule.

## Backups
RDS automated backups daily, 30-day retention, point-in-time restore. Quarterly restore drill (see deployment doc).
