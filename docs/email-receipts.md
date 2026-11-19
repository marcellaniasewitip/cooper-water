# Emailed delivery receipts

When the water is handed over, the customer signs on the driver's phone. The receipt (order, water,
price, payment, driver, truck and the signature) can then be emailed:

- by the **driver** at the door: the customer's email on file is filled in, or the driver types one;
- by the **customer** in the app (order screen → "Email my receipt"), optionally saving the address on
  their profile.

Admins see the signature and where the receipt was sent on the order page.

## Turn on sending (one time)

The API sends mail over **SMTP**, so any mail service works. Until it is set up, receipts are only written
to the server log (nothing is sent) and the apps still say "sent".

Pick one:

| Service | SMTP_URL |
|---|---|
| Amazon SES (same AWS account) | `smtps://SMTP_USER:SMTP_PASSWORD@email-smtp.ap-southeast-2.amazonaws.com:465` (SES → SMTP settings → Create SMTP credentials; verify the sender address or domain; request production access to email any address) |
| Google Workspace / Gmail | `smtps://you%40yourdomain.com:APP_PASSWORD@smtp.gmail.com:465` (an App Password, with 2-step verification on) |
| Microsoft 365 | `smtp://you%40yourdomain.com:PASSWORD@smtp.office365.com:587` |

Write `@` inside the user name as `%40`.

Then in GitHub → **Settings → Secrets and variables → Actions**:

- **Secret** `SMTP_URL`: the line above.
- **Variable** `EMAIL_FROM`: the sender, e.g. `Cooper Waters <receipts@yourdomain.com>` (must be an
  address the mail service lets you send from).

Run **Actions → Deploy to AWS → Run workflow** (or merge any change). Send yourself a receipt to check.
