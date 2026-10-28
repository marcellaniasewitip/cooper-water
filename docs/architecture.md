# Architecture

```
 Customer app ─┐                       ┌──────────── AWS ap-southeast-2 ────────────────────────────┐
 Driver app ───┼── HTTPS / WSS ──► ALB ─┼─► ECS Fargate: api (N tasks, Socket.IO + Redis adapter)   │
 Admin (SPA) ──┘                       │        │  └─ RDS PostgreSQL 16 + PostGIS (Multi-AZ)        │
   ▲ CloudFront + S3                   │        └── ElastiCache Redis ◄── ECS Fargate: worker       │
   │                                   │             (BullMQ queues,       (jobs, sweeper,          │
   │                                   │              socket fan-out)       Redis emitter)          │
   │                                   │  S3 uploads (presigned PUT/GET) · Secrets Manager · CW logs │
   └───────────────────────────────────┴─────────────────────────────────────────────────────────────┘
 Cell money provider ── webhook ──► POST /api/v1/webhooks/cellmoney/:provider
 ClickSend SMS / FCM ◄── NotificationService (push first, SMS for OTP + critical events)
```

## Backend modules (`backend/src`)

| Module | Responsibility |
| --- | --- |
| `orders/state-machine.ts` | **The** order transition table (§6). Pure; unit-tested for every allowed/disallowed transition. |
| `orders/transitions.service.ts` | Applies a transition under a row lock, writes `OrderEvent`, runs money hooks in the same transaction, queues side effects after commit. |
| `orders/dispatch.service.ts` | Radius rounds via PostGIS `ST_DWithin`, offers, re-broadcast, expiry. Idempotent jobs keyed on (status, round, window). |
| `orders/orders.service.ts` | Customer/driver/admin operations, race-safe accept (lock driver row, then order row). |
| `orders/settlement.service.ts` | Commission at acceptance or completion, COD vs cell money settlement, reversals. |
| `wallet/ledger.service.ts` | Append-only ledger; cached balance updated in the same transaction; idempotency key per entry. |
| `wallet/wallet.service.ts` | Top-ups (bank/manual approval), payouts (reserve at request, manual pay-out), adjustments. |
| `payments/*` | `PaymentProvider` interface; `ManualCellMoneyProvider`, `MockCellMoneyProvider`, `ProviderNameCellMoneyProvider` stub; webhooks → job; polling + timeout; refunds. |
| `notifications/*` | `SmsProvider` (mock + ClickSend), FCM push, DB templates, queued retries with backoff, push→SMS fallback. |
| `jobs/*` | BullMQ wrapper + minute sweeper that re-runs any job a lost timer would have handled. |
| `realtime/*` | Socket.IO `/realtime` namespace; Redis adapter (API) + Redis emitter (worker) so events reach every instance. |
| `auth/*` | Phone OTP → JWT + rotating refresh tokens (reuse detection); admin email/password + TOTP; permission-based RBAC; global fail-closed guard. |

## Reliability patterns

- **One transaction per state change** with `SELECT … FOR UPDATE` on the order (and on the driver for accepts).
- **Side effects after commit** (`AfterCommit`): notifications, socket pushes, job scheduling, provider calls.
  If the process dies in between, the sweeper/polling recovers.
- **Idempotency everywhere**: HTTP `Idempotency-Key` (stored responses replayed), ledger idempotency keys,
  webhook event de-duplication, payment `applyStatus` only moves out of open states once (late success → refund).
- **Fleet model**: `Driver` and `Truck` carry a nullable `operator_id` so an Operator/Owner with many trucks can be
  added in Phase 2 without reshaping orders or wallets.

## Dispatch timing

`order.acceptance_timeout_sec` (600 s) is the total search time, split evenly over `1 + order.rebroadcast_rounds`
rounds (default 2 × 300 s), using `order.dispatch_radius_m[round]` (5 km, then 10 km). Drivers who come online or move
during a round are offered open orders already within the current radius.
