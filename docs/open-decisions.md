# Open decisions ([CONFIRM]) and where they live

Nothing below needs a code change — change the setting in **Admin → Settings**, or add/select a provider adapter.

| # | Decision | Current default | Where |
| --- | --- | --- | --- |
| 1 | Cell money provider, API, sandbox, merchant account | `manual` adapter (admin matches payments by order code) | setting `payment.cellmoney.adapter`; implement `backend/src/payments/provider-name-cellmoney.provider.ts`; webhook `POST /api/v1/webhooks/cellmoney/<name>` |
| 2 | Cell money fee bearer / fee % | `platform`, 0 % | `payment.cellmoney.fee_bearer`, `payment.cellmoney.fee_percent` |
| 3 | SMS/OTP gateway | **ClickSend** chosen (adapter built, see `docs/sms-clicksend.md`); `mock` until credentials are added | env `SMS_PROVIDER=clicksend` + `CLICKSEND_*` secrets; Terraform `sms_provider`, `clicksend_from` |
| 4 | Map provider | OpenStreetMap tiles (admin), osmdroid (apps) | admin tile URL config; Android `MapView` wrapper |
| 5 | Commission type / value / when deducted | 10 %, at completion | `commission.type`, `commission.value`, `commission.deduct_at` |
| 6 | Minimum wallet balance | K50 (5000 toea) | `wallet.min_balance_toea` |
| 7 | Acceptance timeout, rounds, radius | 600 s, 1 re-broadcast, 5 km → 10 km | `order.acceptance_timeout_sec`, `order.rebroadcast_rounds`, `order.dispatch_radius_m` |
| 8 | Package price table | Placeholder: 1,000 L K80 · 3,000 L K200 · 5,000 L K300 | Admin → Packages |
| 9 | Depot locations, geofence radius, online gating | 2 placeholder depots, 150 m, gated | Admin → Depots; `depot.geofence_radius_m`; `depot.online_gated` |
| 10 | Required driver documents | licence, vehicle registration, national ID, truck photo | `driver.required_documents` |
| 11 | Cancellation window / dispute categories | free before ACCEPTED; 6 categories | `order.customer_cancel_free_until`, `dispute.categories` |
| 12 | Default admin roles | Super Admin, Operations, Finance, Support | Admin → Roles (`auth/permissions.ts` seeds them) |
| 13 | Hosting region, backup retention | AWS ap-southeast-2, 30 days | Terraform `region`, `db_backup_retention_days` |
| 14 | One active order per driver | yes | `order.one_active_per_driver` |
| 15 | Payout frequency/method | on request, paid manually by Finance | Admin → Payouts; `payout.min_toea` |
| 16 | Android minSdk | 24 | app `build.gradle.kts` |

Cancellation **fees** are out of scope for Phase 1: after the free window customers contact support and an admin cancels.
