# Sign-in codes over WhatsApp (Meta WhatsApp Cloud API)

Customers and drivers sign in with their mobile number. The 6-digit code goes **by WhatsApp first**
and **SMS is the backup**:

| Situation | What happens |
| --- | --- |
| Number is on WhatsApp | Code arrives in WhatsApp with a one-tap **Copy code** button |
| Meta refuses the message (bad number, test-mode restrictions, outage) | SMS sent immediately |
| Meta later reports it undeliverable (number not on WhatsApp) | Same code re-sent by SMS |
| No delivery confirmation within `otp.whatsapp_fallback_sec` (45 s) | Same code re-sent by SMS |
| User taps **"No WhatsApp? Send the code by SMS"** | Same code re-sent by SMS |

The SMS always carries the **same code**, at most once per code, and never after the code was used or
expired. Admins can switch everything back to SMS in **Settings → OTP & sign-in → Send sign-in codes by**.

> ⚠️ SMS is still the mock adapter (`SMS_PROVIDER=mock`), so until an SMS gateway is connected the
> backup only writes codes to the server logs. WhatsApp alone works for numbers that have WhatsApp.

## One-time setup in Meta (about an hour, plus Meta's review times)

1. **Meta Business account** — <https://business.facebook.com>. Start **business verification**
   (Business Settings → Security Centre). Unverified accounts are limited to a small number of
   recipients per day and can't get a display name approved.
2. **App** — <https://developers.facebook.com/apps> → *Create app* → type **Business** → add the
   **WhatsApp** product. Note the **App secret** (App settings → Basic).
3. **Phone number** — WhatsApp → API Setup → *Add phone number*. Use a number that is **not** already
   registered on the WhatsApp or WhatsApp Business app. Set the display name to *Cooper Waters* (Meta
   reviews it). Note the **Phone number ID**.
   *Meta's free test number works for trials but only sends to up to 5 numbers you add as recipients;
   anyone else gets the SMS backup.*
4. **Message template** — WhatsApp Manager → Message templates → *Create template*:
   - Category **Authentication**, name **`cooper_waters_otp`**, language **English**
   - Code delivery: **Copy code**
   - Tick *Add security recommendation* and set *code expires in* **5 minutes**

   Approval is usually quick. A different name? Set `whatsapp_otp_template` in Terraform.
5. **Permanent access token** — Business Settings → Users → **System users** → add an *Admin* system user
   → *Add assets*: the app and the WhatsApp account (full control) → *Generate token* with
   `whatsapp_business_messaging` and `whatsapp_business_management`, expiry **Never**.
6. **Payment method** — WhatsApp Manager → Payment settings. Meta charges per authentication message
   (rates vary by country; see Meta's WhatsApp pricing page).
7. **Webhook** — App → WhatsApp → Configuration:
   - Callback URL: `https://<your API host>/api/v1/webhooks/whatsapp`
   - Verify token: any long random string (the same value goes in `WHATSAPP_VERIFY_TOKEN`)
   - Click *Verify and save*, then **subscribe to the `messages` field** (delivery statuses arrive there).

   Do step 8 first so the server can answer Meta's verification request.

## Connect it to Cooper Waters (AWS)

8. Put the values in Secrets Manager (names from `terraform output secrets_to_fill`):
   ```bash
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/WHATSAPP_ACCESS_TOKEN    --secret-string '<system user token>'
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/WHATSAPP_PHONE_NUMBER_ID --secret-string '<phone number id>'
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/WHATSAPP_APP_SECRET      --secret-string '<app secret>'
   aws secretsmanager put-secret-value --secret-id cooper-waters-prod/WHATSAPP_VERIFY_TOKEN    --secret-string '<verify token>'
   ```
9. In `terraform.tfvars` set `whatsapp_provider = "meta"`, run `terraform apply`, then re-run the
   *Deploy to AWS* workflow so the services pick up the new task definitions.
10. Finish step 7 (webhook), then sign in from the app with a WhatsApp number. Check
    **Admin → Settings → OTP & sign-in** shows *whatsapp*.

## Local development

`WHATSAPP_PROVIDER=mock` logs codes as `mock whatsapp otp` instead of sending them. Numbers ending in
`8888` are refused outright (immediate SMS fallback); with no delivery receipt the SMS backup follows
after 45 s. `WHATSAPP_PROVIDER=none` (the default) means SMS only.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Everyone gets SMS, never WhatsApp | `WHATSAPP_PROVIDER` is `meta` on the running tasks; setting `otp.primary_channel` is `whatsapp`; API logs for `whatsapp otp refused` with Meta's error |
| Error 131030 in logs | Still on Meta's test number — add recipients, or register your real number |
| Error 132001 (template does not exist) | Template name/language doesn't match `WHATSAPP_OTP_TEMPLATE` / `WHATSAPP_OTP_LANGUAGE`, or not approved yet |
| Error 190 (token) | Access token expired or revoked — generate a new system user token |
| Webhook verification fails | `WHATSAPP_VERIFY_TOKEN` differs from the value typed in Meta, or the API isn't reachable over HTTPS |
| Codes arrive twice (WhatsApp + SMS) | Delivery receipts aren't reaching the webhook (step 7), so the 45 s timer sends SMS too |
