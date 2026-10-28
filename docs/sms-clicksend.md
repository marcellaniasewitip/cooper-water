# SMS through ClickSend

Sign-in codes (OTP) and critical alerts (order accepted, driver arrived, order expired, payment failed,
refund issued, top-up approved/rejected) go by SMS through [ClickSend](https://www.clicksend.com).
Push notifications stay first for everything else (§9).

## Behaviour

- Sign-in codes are sent immediately. A temporary ClickSend failure (network, HTTP 5xx) is retried
  automatically with backoff.
- A **permanent** refusal (`INVALID_RECIPIENT`, `COUNTRY_NOT_ENABLED`, `INSUFFICIENT_CREDIT`,
  `INVALID_SENDER_ID`, bad credentials) is not retried. For sign-in codes the app shows
  *"We couldn't send a code to this number. Check it and try again."*
- Every send is a row in the `notifications` table (status, attempts, last error), so failures are
  visible in the database and logs.

## One-time setup in ClickSend

1. Create an account at <https://dashboard.clicksend.com/signup> and verify it.
2. **Add credit** (Billing). ClickSend is prepaid; sends fail with `INSUFFICIENT_CREDIT` when it runs out.
   Set up a low-balance alert or auto top-up.
3. **Check Papua New Guinea delivery and sender ID** with ClickSend (pricing page / support):
   - whether PNG networks (Digicel, bmobile/Vodafone) accept an **alphanumeric sender ID** such as
     `CooperWater` (max 11 characters), or require a **dedicated number**;
   - if neither, leave the sender empty and ClickSend uses its shared number.
4. **API credentials** — Dashboard → *Developers → API Credentials*: copy the **username** and
   **API key**.
5. Send yourself a test SMS from the dashboard to a PNG number to confirm delivery.

## Connect it to Cooper Waters (AWS)

6. Store the credentials in Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/CLICKSEND_USERNAME --secret-string '<username>'
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/CLICKSEND_API_KEY  --secret-string '<api key>'
   ```
7. In `infra/terraform/terraform.tfvars`:
   ```hcl
   sms_provider   = "clicksend"
   clicksend_from = "CooperWater"   # or a dedicated number, or "" for ClickSend's shared number
   ```
   Run `terraform apply`, then re-run the **Deploy to AWS** workflow so the API and worker pick up the
   new settings.
8. Sign in from the customer or driver app with your own number: the code should arrive within seconds.

## Local development

`.env`: `SMS_PROVIDER=mock` writes codes to the log (`mock sms`). To try ClickSend locally set
`SMS_PROVIDER=clicksend` plus `CLICKSEND_USERNAME`, `CLICKSEND_API_KEY` and optionally `CLICKSEND_FROM`.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Codes only in logs | Running tasks still have `SMS_PROVIDER=mock`; apply Terraform and redeploy |
| API fails to start: *requires CLICKSEND_USERNAME and CLICKSEND_API_KEY* | Secrets are empty or still the `" "` placeholder |
| `ClickSend rejected the credentials` | Wrong username/API key, or the key was regenerated |
| `INSUFFICIENT_CREDIT` | Top up the ClickSend account |
| `INVALID_SENDER_ID` or messages not arriving | PNG may not accept the sender ID — try a dedicated number or an empty `clicksend_from` |
| `INVALID_RECIPIENT` | The number is wrong or not a mobile number |
