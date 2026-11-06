/**
 * End-to-end simulator (§13): runs complete orders against the mock providers with the REAL job queue
 * (BullMQ on Redis), webhooks and WebSockets — the same moving parts as production.
 *
 *   npm run seed && npm run simulate
 *
 * Boots the API in-process (so it can read OTPs from the mock SMS outbox), then over HTTP:
 *   1. onboards a new driver (documents, truck, admin approval, bank top-up approved by Finance)
 *   2. a customer places a CELL MONEY order → mock provider sends a (duplicated) signed webhook via the queue
 *   3. the driver receives the offer over WebSocket, accepts, loads at the depot, delivers
 *   4. the customer watches status over WebSocket, confirms receipt and rates the driver
 *   5. a COD order runs the same way; the ledger is checked at the end
 * Uses DATABASE_URL / REDIS_URL from the environment (.env). Exits non-zero on any failure.
 */
import 'reflect-metadata';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AddressInfo } from 'net';
import { io, Socket } from 'socket.io-client';

loadEnvFile();
process.env.JOBS_DRIVER = 'bullmq';
// Own queue/socket namespace so a dev server sharing this Redis doesn't steal the simulator's jobs.
process.env.REDIS_PREFIX = process.env.SIM_REDIS_PREFIX ?? `sim-${Date.now()}`;
process.env.LOG_LEVEL = process.env.SIM_LOG_LEVEL ?? 'warn';
process.env.SMS_PROVIDER = 'mock';
process.env.PUSH_PROVIDER = 'mock';
// Upload URLs are only presigned (signing is offline), never used, so placeholder credentials suffice.
process.env.AWS_ACCESS_KEY_ID ??= 'simulator';
process.env.AWS_SECRET_ACCESS_KEY ??= 'simulator';

/* eslint-disable no-console */
const step = (msg: string) => console.log(`\n▶ ${msg}`);
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const kina = (t: number) => `K${(t / 100).toFixed(2)}`;

function loadEnvFile() {
  const p = join(__dirname, '..', '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

async function main() {
  const { createApp } = await import('../src/bootstrap');
  const { JobsService } = await import('../src/jobs/jobs.service');
  const { SettingsService } = await import('../src/settings/settings.service');
  const { PrismaService } = await import('../src/prisma/prisma.service');
  const { MockSmsProvider } = await import('../src/notifications/sms.provider');
  const { PaymentProvidersRegistry } = await import('../src/payments/providers.registry');

  const app = await createApp({ logger: false });
  await app.init();
  // SIM_START_WORKERS=false: rely on a separately running `npm run start:worker` (same REDIS_PREFIX),
  // which is how production runs (API and worker are separate ECS services).
  if (process.env.SIM_START_WORKERS !== 'false') await app.get(JobsService).startWorkers();
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const prisma = app.get(PrismaService);
  const settings = app.get(SettingsService);
  app.get(PaymentProvidersRegistry).mock.webhookDelayMs = 1500;
  console.log(`Simulator API on ${base} (BullMQ on ${process.env.REDIS_URL})`);

  const depot = await prisma.depot.findFirst({ where: { active: true, deletedAt: null } });
  const pkg = await prisma.package.findFirst({ where: { active: true, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  if (!depot || !pkg) throw new Error('No depot/package found — run `npm run seed` first');
  const adapterBefore = await settings.get('payment.cellmoney.adapter');
  await settings.set('payment.cellmoney.adapter', 'mock', null);

  async function api(method: string, path: string, opts: { token?: string; body?: unknown; idem?: string; expect?: number } = {}) {
    const res = await fetch(`${base}/api/v1${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.idem ? { 'idempotency-key': opts.idem } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    const expected = opts.expect ?? (method === 'POST' && !path.includes('/auth/') ? undefined : 200);
    if ((expected && res.status !== expected) || res.status >= 400) {
      throw new Error(`${method} ${path} → ${res.status} ${text}`);
    }
    return json;
  }

  async function otp(phone: string, app: 'customer' | 'driver', name: string) {
    const r = await api('POST', '/auth/otp/request', { body: { phone } });
    // Training mode returns the code directly; otherwise read it from the mock SMS outbox.
    const code = (r.trainingCode as string | undefined) ?? /(\d{6})/.exec(MockSmsProvider.lastTo(r.phone)!)![1];
    const v = await api('POST', '/auth/otp/verify', { body: { phone, code, app, name } });
    return v.accessToken as string;
  }

  function socket(token: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = io(`${base}/realtime`, { auth: { token }, transports: ['websocket'] });
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  function waitFor<T = any>(s: Socket, event: string, pred: (p: any) => boolean, timeoutMs = 20000): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
      const h = (p: any) => {
        if (pred(p)) {
          clearTimeout(t);
          s.off(event, h);
          resolve(p);
        }
      };
      s.on(event, h);
    });
  }

  const rand = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
  const sockets: Socket[] = [];
  try {
    // ── 1. Driver onboarding ──
    step('Driver onboarding');
    const adminRes = await api('POST', '/auth/admin/login', { body: { email: 'super.admin@cooperwaters.com.pg', password: process.env.SEED_ADMIN_PASSWORD ?? 'CooperWaters2024!' } });
    if (adminRes.mfaRequired) throw new Error('Seed super admin has TOTP enabled; disable it for the simulator');
    const admin = adminRes.accessToken as string;
    const driverToken = await otp(`8${rand()}`, 'driver', 'Sim Driver');
    const cfg = await api('GET', '/driver/config', { token: driverToken });
    for (const type of cfg.requiredDocuments as string[]) {
      const up = await api('POST', '/driver/uploads', { token: driverToken, body: { purpose: 'document', contentType: 'image/jpeg', contentLength: 50_000 } });
      await api('POST', '/driver/documents', { token: driverToken, body: { type, fileKey: up.key } });
    }
    await api('PUT', '/driver/truck', { token: driverToken, body: { plate: `SIM${rand().slice(0, 3)}`, capacityLitres: 5000 } });
    let me = await api('GET', '/driver/me', { token: driverToken });
    ok(`documents + truck submitted → ${me.status}`);
    const detail = await api('GET', `/admin/drivers/${me.id}`, { token: admin });
    for (const d of detail.documents) await api('POST', `/admin/drivers/documents/${d.id}/review`, { token: admin, body: { status: 'approved' } });
    await api('POST', `/admin/drivers/${me.id}/approve`, { token: admin, body: {} });
    const topup = await api('POST', '/driver/wallet/topups', { token: driverToken, idem: randomUUID(), body: { method: 'bank_transfer', amountToea: 10000, referenceText: 'SIM-BSP-1' } });
    await api('POST', `/admin/topups/${topup.topup.id}/approve`, { token: admin });
    me = await api('GET', '/driver/me', { token: driverToken });
    ok(`approved; wallet ${kina(me.wallet.balanceToea)}`);

    const driverSock = await socket(driverToken);
    sockets.push(driverSock);
    await api('POST', '/driver/online', { token: driverToken, body: { lat: depot.lat, lng: depot.lng } });
    ok(`online at ${depot.name}`);

    // Keep other seeded drivers from grabbing the simulator's orders.
    await prisma.driver.updateMany({ where: { id: { not: me.id }, online: true }, data: { online: false } });

    const customerToken = await otp(`7${rand()}`, 'customer', 'Sim Customer');
    const customerSock = await socket(customerToken);
    sockets.push(customerSock);
    const dropoff = { lat: depot.lat - 0.004, lng: depot.lng + 0.004, address: 'Section 21, Lot 7, Waigani', notes: 'Green house behind the church' };

    const runOrder = async (paymentMethod: 'cod' | 'cellmoney') => {
      step(`${paymentMethod.toUpperCase()} order`);
      const walletBefore = (await api('GET', '/driver/wallet', { token: driverToken })).balanceToea as number;
      const offerP = waitFor(driverSock, 'order.offer', () => true, 30000);
      const created = await api('POST', '/customer/orders', {
        token: customerToken,
        idem: randomUUID(),
        body: { packageId: pkg!.id, quantity: 1, paymentMethod, msisdn: paymentMethod === 'cellmoney' ? '+67579995555' : undefined, location: dropoff },
      });
      const orderId = created.order.id as string;
      ok(`placed ${created.order.shortCode} (${kina(created.order.priceToea)}) → ${created.order.status}`);
      if (paymentMethod === 'cellmoney') {
        ok(`payment ${created.payment.status}: ${created.payment.instructions}`);
        await waitFor(customerSock, 'order.updated', (p) => p.order.id === orderId && p.order.status === 'SEARCHING');
        ok('webhook (delivered twice via BullMQ) → payment succeeded → SEARCHING');
      }
      const { offer } = await offerP;
      ok(`driver got offer over WebSocket: ${offer.volumeLitres} L, ${(offer.distanceM / 1000).toFixed(1)} km, earn ${kina(offer.earningsToea)}`);
      await api('POST', `/driver/orders/${orderId}/accept`, { token: driverToken, idem: randomUUID() });
      for (const [path, body] of [
        ['arrive-depot', { lat: depot!.lat, lng: depot!.lng }],
        ['loaded', { lat: depot!.lat, lng: depot!.lng }],
      ] as const) {
        await api('POST', `/driver/orders/${orderId}/${path}`, { token: driverToken, body });
      }
      const trackP = waitFor(customerSock, 'order.driver_location', (p) => p.orderId === orderId);
      await api('POST', '/driver/location', { token: driverToken, body: { points: [{ lat: dropoff.lat + 0.001, lng: dropoff.lng, at: new Date().toISOString() }] } });
      await trackP;
      ok('customer received live driver location');
      await api('POST', `/driver/orders/${orderId}/arrived`, { token: driverToken, body: {} });
      await api('POST', `/driver/orders/${orderId}/delivered`, { token: driverToken, body: {} });
      const done = await api('POST', `/customer/orders/${orderId}/confirm`, { token: customerToken });
      await api('POST', `/customer/orders/${orderId}/rating`, { token: customerToken, body: { stars: 5, comment: 'Fast!' } });
      ok(`timeline: ${Object.entries(done.timeline).filter(([, v]) => v).map(([k]) => k.replace(/At$/, '')).join(' → ')}`);
      const walletAfter = (await api('GET', '/driver/wallet', { token: driverToken })).balanceToea as number;
      const commission = (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).commissionToea;
      const expected = paymentMethod === 'cod' ? walletBefore - commission : walletBefore + done.priceToea - commission;
      if (walletAfter !== expected) throw new Error(`wallet ${walletAfter} != expected ${expected}`);
      ok(`driver wallet ${kina(walletBefore)} → ${kina(walletAfter)} (commission ${kina(commission)})`);
      const events = await prisma.orderEvent.count({ where: { orderId, toStatus: 'SEARCHING' } });
      if (events !== 1) throw new Error(`expected exactly one SEARCHING event, got ${events}`);
    };

    await runOrder('cellmoney');
    await runOrder('cod');

    step('Ledger check');
    const wallets = await prisma.wallet.findMany();
    for (const w of wallets) {
      const sum = await prisma.ledgerEntry.aggregate({ where: { walletId: w.id }, _sum: { amountToea: true } });
      if ((sum._sum.amountToea ?? 0) !== w.balanceToea) throw new Error(`wallet ${w.id} cached balance ${w.balanceToea} != ledger ${sum._sum.amountToea}`);
    }
    ok(`${wallets.length} wallets: cached balances equal ledger sums`);
    console.log('\nSIMULATION PASSED');
  } finally {
    sockets.forEach((s) => s.close());
    await settings.set('payment.cellmoney.adapter', adapterBefore, null);
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nSIMULATION FAILED:', err.message ?? err);
    process.exit(1);
  });
