import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { createApp } from '../../src/bootstrap';
import { PrismaService } from '../../src/prisma/prisma.service';
import { JobsService } from '../../src/jobs/jobs.service';
import { SettingsService } from '../../src/settings/settings.service';
import { PaymentProvidersRegistry } from '../../src/payments/providers.registry';
import { MockSmsProvider } from '../../src/notifications/sms.provider';
import { DEFAULT_ROLES, PERMISSIONS } from '../../src/auth/permissions';
import { PLATFORM_OWNER_ID } from '../../src/wallet/ledger.service';

export const DEPOT = { lat: -9.4438, lng: 147.1803 };
export const CUSTOMER_POINT = { lat: -9.4475, lng: 147.1850 }; // ~650 m from the depot
export const ADMIN_PASSWORD = 'TestPassword123!';

export interface Harness {
  app: INestApplication;
  prisma: PrismaService;
  jobs: JobsService;
  settings: SettingsService;
  registry: PaymentProvidersRegistry;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function startApp(): Promise<Harness> {
  const app = await createApp({ logger: false });
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    jobs: app.get(JobsService),
    settings: app.get(SettingsService),
    registry: app.get(PaymentProvidersRegistry),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

const TABLES = [
  'audit_logs', 'idempotency_records', 'notifications', 'notification_templates', 'settings', 'ratings', 'disputes',
  'payouts', 'webhook_events', 'topup_requests', 'payments', 'ledger_entries', 'wallets', 'order_offers', 'order_events',
  'orders', 'packages', 'depots', 'trucks', 'driver_documents', 'drivers', 'customer_locations', 'refresh_tokens',
  'otp_codes', 'users', 'role_permissions', 'permissions', 'admin_users', 'roles',
];

/** Wipe the test DB and seed the minimum every test needs. */
export async function resetDb(h: Harness) {
  await h.prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} CASCADE`);
  h.settings.invalidate();
  h.jobs.scheduled.splice(0);
  MockSmsProvider.outbox.splice(0);

  for (const [key, description] of Object.entries(PERMISSIONS)) await h.prisma.permission.create({ data: { key, description } });
  const perms = new Map((await h.prisma.permission.findMany()).map((p) => [p.key, p.id]));
  const hash = await bcrypt.hash(ADMIN_PASSWORD, 4);
  for (const [name, def] of Object.entries(DEFAULT_ROLES)) {
    const role = await h.prisma.role.create({ data: { name, isSystem: true } });
    await h.prisma.rolePermission.createMany({ data: def.permissions.map((k) => ({ roleId: role.id, permissionId: perms.get(k)! })) });
    await h.prisma.adminUser.create({ data: { email: `${name.toLowerCase().replace(/\s+/g, '.')}@test.pg`, name, passwordHash: hash, roleId: role.id } });
  }
  await h.prisma.wallet.create({ data: { ownerType: 'platform', ownerId: PLATFORM_OWNER_ID } });
  await h.prisma.setting.create({ data: { key: 'otp.max_sends_per_ip_per_hour', value: 100000 } });
  const depot = await h.prisma.depot.create({ data: { name: 'Test Depot', ...DEPOT } });
  const pkg = await h.prisma.package.create({ data: { name: '5000 L', volumeLitres: 5000, priceToea: 30000 } });
  return { depot, pkg };
}

export async function otpLogin(h: Harness, phone: string, app: 'customer' | 'driver', name?: string): Promise<{ token: string; userId: string; refreshToken: string }> {
  const r1 = await h.http().post('/api/v1/auth/otp/request').send({ phone });
  if (r1.status !== 200) throw new Error(`otp request failed ${r1.status} ${JSON.stringify(r1.body)}`);
  const body = MockSmsProvider.lastTo(r1.body.phone)!;
  const code = /(\d{6})/.exec(body)![1];
  const r2 = await h.http().post('/api/v1/auth/otp/verify').send({ phone, code, app, name });
  if (r2.status !== 200) throw new Error(`otp verify failed ${r2.status} ${JSON.stringify(r2.body)}`);
  return { token: r2.body.accessToken, userId: r2.body.user.id, refreshToken: r2.body.refreshToken };
}

export async function adminLogin(h: Harness, role = 'super.admin'): Promise<string> {
  const r = await h.http().post('/api/v1/auth/admin/login').send({ email: `${role}@test.pg`, password: ADMIN_PASSWORD });
  if (r.status !== 200) throw new Error(`admin login failed ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

let phoneSeq = 1000;
export function nextPhone(prefix: '7' | '8' = '7'): string {
  phoneSeq++;
  return `${prefix}${String(phoneSeq).padStart(7, '0')}`;
}

/** An approved driver with a truck, approved docs, a funded wallet, online at the depot. */
export async function approvedDriver(h: Harness, opts: { balanceToea?: number; online?: boolean; at?: { lat: number; lng: number } } = {}) {
  const login = await otpLogin(h, nextPhone('8'), 'driver', 'Test Driver');
  const driver = await h.prisma.driver.findUniqueOrThrow({ where: { userId: login.userId } });
  await h.prisma.driver.update({ where: { id: driver.id }, data: { status: 'approved' } });
  await h.prisma.truck.create({ data: { driverId: driver.id, plate: `T${randomUUID().slice(0, 6).toUpperCase()}`, capacityLitres: 5000 } });
  const balance = opts.balanceToea ?? 20000;
  if (balance !== 0) {
    const wallet = await h.prisma.wallet.findUniqueOrThrow({ where: { ownerType_ownerId: { ownerType: 'driver', ownerId: driver.id } } });
    await h.prisma.ledgerEntry.create({
      data: { walletId: wallet.id, amountToea: balance, balanceAfter: balance, type: 'topup', referenceType: 'test', referenceId: driver.id, idempotencyKey: `test-topup:${driver.id}`, createdBy: 'system' },
    });
    await h.prisma.wallet.update({ where: { id: wallet.id }, data: { balanceToea: balance } });
  }
  if (opts.online !== false) {
    const at = opts.at ?? DEPOT;
    const r = await h.http().post('/api/v1/driver/online').set('Authorization', `Bearer ${login.token}`).send(at);
    if (r.status !== 200) throw new Error(`online failed ${JSON.stringify(r.body)}`);
  }
  return { ...login, driverId: driver.id };
}

export async function customer(h: Harness) {
  return otpLogin(h, nextPhone('7'), 'customer', 'Test Customer');
}

export function idem(): string {
  return randomUUID();
}

export async function walletBalance(h: Harness, ownerType: 'driver' | 'platform', ownerId: string): Promise<number> {
  const w = await h.prisma.wallet.findUniqueOrThrow({ where: { ownerType_ownerId: { ownerType, ownerId } } });
  const sum = await h.prisma.ledgerEntry.aggregate({ where: { walletId: w.id }, _sum: { amountToea: true } });
  // The cached balance must always equal the ledger sum.
  expect(w.balanceToea).toBe(sum._sum.amountToea ?? 0);
  return w.balanceToea;
}

/** Push an order's current dispatch window into the past and fire its timer. */
export async function expireRound(h: Harness, orderId: string) {
  const o = await h.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  await h.prisma.order.update({ where: { id: orderId }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await h.jobs.run('dispatch.round_timeout', { orderId, round: o.dispatchRound });
}
