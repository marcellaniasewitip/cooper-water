import { authenticator } from 'otplib';
import { Harness, startApp, resetDb, approvedDriver, customer, idem, adminLogin, nextPhone, otpLogin, DEPOT, CUSTOMER_POINT, ADMIN_PASSWORD } from './harness';
import { MockSmsProvider } from '../../src/notifications/sms.provider';
import { MockPushProvider } from '../../src/notifications/push.provider';
import { NotificationsService } from '../../src/notifications/notifications.service';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('auth, RBAC, onboarding, notifications, reports (integration)', () => {
  let h: Harness;
  let pkgId: string;

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    const { pkg } = await resetDb(h);
    pkgId = pkg.id;
    MockPushProvider.sent.splice(0);
  });

  describe('OTP', () => {
    it('wrong codes are counted and lock out after max attempts', async () => {
      const phone = nextPhone();
      const r = await h.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      for (let i = 0; i < 5; i++) {
        const bad = await h.http().post('/api/v1/auth/otp/verify').send({ phone, code: '000000', app: 'customer' });
        expect(bad.body.error.code).toBe(i < 5 ? 'otp_invalid' : 'rate_limited');
      }
      const code = /(\d{6})/.exec(MockSmsProvider.lastTo(r.body.phone)!)![1];
      const locked = await h.http().post('/api/v1/auth/otp/verify').send({ phone, code, app: 'customer' });
      expect(locked.status).toBe(429);
    });

    it('codes are single use and expire', async () => {
      const phone = nextPhone();
      const r = await h.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const code = /(\d{6})/.exec(MockSmsProvider.lastTo(r.body.phone)!)![1];
      await h.http().post('/api/v1/auth/otp/verify').send({ phone, code, app: 'customer' }).expect(200);
      const reuse = await h.http().post('/api/v1/auth/otp/verify').send({ phone, code, app: 'customer' });
      expect(reuse.status).toBe(422);
      const r2 = await h.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      await h.prisma.otpCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const code2 = /(\d{6})/.exec(MockSmsProvider.lastTo(r2.body.phone)!)![1];
      expect((await h.http().post('/api/v1/auth/otp/verify').send({ phone, code: code2, app: 'customer' })).body.error.code).toBe('otp_expired');
    });

    it('tells the user when the SMS gateway permanently refuses the number', async () => {
      MockSmsProvider.failNextPermanent = 1;
      const r = await h.http().post('/api/v1/auth/otp/request').send({ phone: nextPhone() });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('sms_undeliverable');
      const n = await h.prisma.notification.findFirstOrThrow({ where: { template: 'auth.otp' }, orderBy: { createdAt: 'desc' } });
      expect(n.status).toBe('failed');
      expect(n.attempts).toBe(1); // not retried
      expect(h.jobs.scheduled.filter((j) => j.name === 'notifications.send')).toHaveLength(0);
    });

    it('rate-limits OTP sends per phone', async () => {
      const phone = nextPhone();
      for (let i = 0; i < 5; i++) await h.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const r = await h.http().post('/api/v1/auth/otp/request').send({ phone });
      expect(r.status).toBe(429);
    });

    it('one phone = one role', async () => {
      const phone = nextPhone();
      await otpLogin(h, phone, 'driver');
      const r1 = await h.http().post('/api/v1/auth/otp/request').send({ phone }).expect(200);
      const code = /(\d{6})/.exec(MockSmsProvider.lastTo(r1.body.phone)!)![1];
      const r = await h.http().post('/api/v1/auth/otp/verify').send({ phone, code, app: 'customer' });
      expect(r.status).toBe(403);
      expect(r.body.error.message).toMatch(/Driver app/);
    });
  });

  it('refresh tokens rotate and reuse revokes the session family', async () => {
    const c = await customer(h);
    const r1 = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken }).expect(200);
    // Pretend the rotation happened long ago: reuse outside the retry grace is treated as theft.
    await h.prisma.refreshToken.updateMany({ where: { userId: c.userId, revokedAt: { not: null } }, data: { revokedAt: new Date(Date.now() - 10 * 60_000) } });
    const reuse = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken });
    expect(reuse.status).toBe(401);
    // Reuse killed the newer token too.
    expect((await h.http().post('/api/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
  });

  it('a refresh retried right after rotation (lost response) keeps the customer signed in', async () => {
    const c = await customer(h);
    const r1 = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken }).expect(200);
    const retry = await h.http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken }).expect(200);
    expect(retry.body.refreshToken).not.toBe(r1.body.refreshToken);
    await h.http().post('/api/v1/auth/refresh').send({ refreshToken: retry.body.refreshToken }).expect(200);
  });

  it('a logged-out refresh token gets no grace', async () => {
    const c = await customer(h);
    await h.http().post('/api/v1/auth/logout').send({ refreshToken: c.refreshToken });
    expect((await h.http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken })).status).toBe(401);
  });

  it('admin TOTP: setup, enable, then login requires the second factor', async () => {
    const token = await adminLogin(h);
    const setup = await h.http().post('/api/v1/auth/admin/totp/setup').set(bearer(token)).send().expect(200);
    await h.http().post('/api/v1/auth/admin/totp/enable').set(bearer(token)).send({ code: authenticator.generate(setup.body.secret) }).expect(204);
    const login = await h.http().post('/api/v1/auth/admin/login').send({ email: 'super.admin@test.pg', password: ADMIN_PASSWORD }).expect(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.accessToken).toBeUndefined();
    // The MFA token alone can't call admin APIs.
    expect((await h.http().get('/api/v1/admin/overview').set(bearer(login.body.mfaToken))).status).toBe(403);
    const bad = await h.http().post('/api/v1/auth/admin/totp/verify').send({ mfaToken: login.body.mfaToken, code: '000000' });
    expect(bad.status).toBe(422);
    const ok = await h.http().post('/api/v1/auth/admin/totp/verify').send({ mfaToken: login.body.mfaToken, code: authenticator.generate(setup.body.secret) }).expect(200);
    await h.http().get('/api/v1/admin/overview').set(bearer(ok.body.accessToken)).expect(200);
  });

  it('wrong admin password is rejected and audited', async () => {
    const r = await h.http().post('/api/v1/auth/admin/login').send({ email: 'super.admin@test.pg', password: 'nope' });
    expect(r.status).toBe(401);
    expect(await h.prisma.auditLog.count({ where: { action: 'auth.login_failed' } })).toBe(1);
  });

  it('RBAC: route groups and permissions are enforced', async () => {
    const support = await adminLogin(h, 'support');
    const finance = await adminLogin(h, 'finance');
    const c = await customer(h);
    expect((await h.http().get('/api/v1/admin/settings').set(bearer(support))).status).toBe(403);
    expect((await h.http().get('/api/v1/admin/settings').set(bearer(finance))).status).toBe(200);
    expect((await h.http().get('/api/v1/admin/overview').set(bearer(c.token))).status).toBe(403);
    expect((await h.http().get('/api/v1/customer/me').set(bearer(support))).status).toBe(403);
    expect((await h.http().get('/api/v1/customer/me')).status).toBe(401);
    expect((await h.http().get('/api/v1/admin/admins').set(bearer(finance))).status).toBe(403);
  });

  it('settings changes are validated and audited', async () => {
    const admin = await adminLogin(h);
    const bad = await h.http().put('/api/v1/admin/settings/commission.type').set(bearer(admin)).send({ value: 'weird' });
    expect(bad.status).toBe(422);
    await h.http().put('/api/v1/admin/settings/wallet.min_balance_toea').set(bearer(admin)).send({ value: 8000 }).expect(200);
    const badAdapter = await h.http().put('/api/v1/admin/settings/payment.cellmoney.adapter').set(bearer(admin)).send({ value: 'nope' });
    expect(badAdapter.body.error.code).toBe('unknown_adapter');
    const all = await h.http().get('/api/v1/admin/settings').set(bearer(admin)).expect(200);
    expect(all.body['wallet.min_balance_toea']).toEqual({ value: 8000, isDefault: false });
    const log = await h.prisma.auditLog.findFirstOrThrow({ where: { action: 'setting.update' } });
    expect(log).toMatchObject({ entityId: 'wallet.min_balance_toea', before: 5000, after: 8000 });
  });

  it('admin roles are editable and take effect', async () => {
    const admin = await adminLogin(h);
    const support = await adminLogin(h, 'support');
    expect((await h.http().get('/api/v1/admin/reports/daily').set(bearer(support))).status).toBe(403);
    const roles = await h.http().get('/api/v1/admin/roles').set(bearer(admin)).expect(200);
    const sup = roles.body.find((r: any) => r.name === 'Support');
    await h.http().put(`/api/v1/admin/roles/${sup.id}`).set(bearer(admin)).send({ name: 'Support', permissions: [...sup.permissions, 'reports.view'] }).expect(200);
    expect((await h.http().get('/api/v1/admin/reports/daily').set(bearer(support))).status).toBe(200);
  });

  it('suspended customers are locked out', async () => {
    const c = await customer(h);
    const ops = await adminLogin(h, 'operations');
    await h.http().post(`/api/v1/admin/customers/${c.userId}/suspend`).set(bearer(ops)).send().expect(403); // ops lacks customers.manage
    const admin = await adminLogin(h);
    await h.http().post(`/api/v1/admin/customers/${c.userId}/suspend`).set(bearer(admin)).send().expect(200);
    expect((await h.http().get('/api/v1/customer/me').set(bearer(c.token))).status).toBe(403);
    expect((await h.http().post('/api/v1/auth/refresh').send({ refreshToken: c.refreshToken })).status).toBe(401);
  });

  it('driver onboarding: documents + truck → pending_approval → approve (requires approved docs)', async () => {
    const d = await otpLogin(h, nextPhone('8'), 'driver', 'New Driver');
    const driver = await h.prisma.driver.findUniqueOrThrow({ where: { userId: d.userId } });
    const me = await h.http().get('/api/v1/driver/me').set(bearer(d.token)).expect(200);
    expect(me.body.status).toBe('pending_docs');
    expect(me.body.documents.every((x: any) => x.status === 'missing')).toBe(true);

    const up = await h.http().post('/api/v1/driver/uploads').set(bearer(d.token)).send({ purpose: 'document', contentType: 'image/jpeg', contentLength: 120000 }).expect(200);
    expect(up.body.url).toContain('X-Amz-Signature');
    // Keys belonging to someone else are refused.
    const stolen = await h.http().post('/api/v1/driver/documents').set(bearer(d.token)).send({ type: 'national_id', fileKey: 'driver-documents/other/x.jpg' });
    expect(stolen.status).toBe(422);

    const docs = ['drivers_licence', 'vehicle_registration', 'national_id', 'truck_photo'];
    for (const type of docs) {
      const u = await h.http().post('/api/v1/driver/uploads').set(bearer(d.token)).send({ purpose: 'document', contentType: 'image/jpeg', contentLength: 1000 });
      await h.http().post('/api/v1/driver/documents').set(bearer(d.token)).send({ type, fileKey: u.body.key }).expect(201);
    }
    expect((await h.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).status).toBe('pending_docs'); // no truck yet
    await h.http().put('/api/v1/driver/truck').set(bearer(d.token)).send({ plate: 'cw 900', capacityLitres: 5000 }).expect(200);
    expect((await h.prisma.driver.findUniqueOrThrow({ where: { id: driver.id } })).status).toBe('pending_approval');

    const ops = await adminLogin(h, 'operations');
    const early = await h.http().post(`/api/v1/admin/drivers/${driver.id}/approve`).set(bearer(ops)).send({});
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('documents_not_approved');
    const detail = await h.http().get(`/api/v1/admin/drivers/${driver.id}`).set(bearer(ops)).expect(200);
    for (const doc of detail.body.documents) {
      await h.http().post(`/api/v1/admin/drivers/documents/${doc.id}/review`).set(bearer(ops)).send({ status: 'approved' }).expect(200);
    }
    await h.http().post(`/api/v1/admin/drivers/${driver.id}/approve`).set(bearer(ops)).send({}).expect(200);
    expect((await h.http().get('/api/v1/driver/me').set(bearer(d.token))).body.status).toBe('approved');
    // Can't go online without funds, nor away from a depot.
    expect((await h.http().post('/api/v1/driver/online').set(bearer(d.token)).send(DEPOT)).body.error.code).toBe('wallet_below_minimum');
  });

  it('going online is depot-gated when configured', async () => {
    const d = await approvedDriver(h, { online: false });
    const away = await h.http().post('/api/v1/driver/online').set(bearer(d.token)).send(CUSTOMER_POINT);
    expect(away.body.error.code).toBe('not_at_depot');
    await h.settings.set('depot.online_gated', false, null);
    await h.http().post('/api/v1/driver/online').set(bearer(d.token)).send(CUSTOMER_POINT).expect(200);
  });

  it('a driver coming online is offered already-open nearby orders', async () => {
    const c = await customer(h);
    const r = await h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', idem()).send({ packageId: pkgId, quantity: 1, paymentMethod: 'cod', location: { ...CUSTOMER_POINT, address: 'x' } }).expect(201);
    expect(await h.prisma.orderOffer.count()).toBe(0);
    const d = await approvedDriver(h);
    const offers = await h.http().get('/api/v1/driver/offers').set(bearer(d.token)).expect(200);
    expect(offers.body.map((o: any) => o.orderId)).toEqual([r.body.order.id]);
  });

  it('notifications: push when possible, SMS for critical events, SMS fallback when push fails', async () => {
    const c = await customer(h);
    await h.http().put('/api/v1/customer/me/push-token').set(bearer(c.token)).send({ token: 'fcm-token-1' }).expect(204);
    const d = await approvedDriver(h);
    const r = await h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', idem()).send({ packageId: pkgId, quantity: 1, paymentMethod: 'cod', location: { ...CUSTOMER_POINT, address: 'x' } }).expect(201);
    MockSmsProvider.outbox.splice(0);
    await h.http().post(`/api/v1/driver/orders/${r.body.order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await h.jobs.drain('notifications.send', true);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { id: c.userId } });
    expect(MockPushProvider.sent.some((m) => m.token === 'fcm-token-1' && m.title === 'Driver on the way')).toBe(true);
    // order.accepted is critical → also SMS.
    expect(MockSmsProvider.outbox.some((m) => m.to === user.phone && m.body.includes('accepted order'))).toBe(true);

    // Push keeps failing → retried with backoff, then falls back to SMS (template has an SMS body).
    const svc = h.app.get(NotificationsService);
    MockPushProvider.failNext = 100;
    MockSmsProvider.outbox.splice(0);
    await svc.notify(c.userId, 'order.payment_pending', { shortCode: 'CW-12345', amount: 'K300.00', instructions: '' });
    for (let i = 0; i < 10; i++) await h.jobs.drain('notifications.send', true).catch(() => undefined);
    MockPushProvider.failNext = 0;
    const push = await h.prisma.notification.findFirstOrThrow({ where: { userId: c.userId, template: 'order.payment_pending', channel: 'push' } });
    expect(push).toMatchObject({ status: 'failed', attempts: 5 });
    const sms = await h.prisma.notification.findFirstOrThrow({ where: { userId: c.userId, template: 'order.payment_pending', channel: 'sms' } });
    expect(sms.status).toBe('sent');
    expect(MockSmsProvider.outbox.some((m) => m.to === user.phone && m.body.includes('CW-12345'))).toBe(true);
  });

  it('notification templates enforce GSM-7 and length', async () => {
    const admin = await adminLogin(h);
    expect((await h.http().put('/api/v1/admin/notification-templates/order.accepted').set(bearer(admin)).send({ smsBody: 'Driver coming 🚚' })).body.error.code).toBe('sms_not_gsm7');
    expect((await h.http().put('/api/v1/admin/notification-templates/order.accepted').set(bearer(admin)).send({ smsBody: 'x'.repeat(161) })).body.error.code).toBe('sms_too_long');
    await h.http().put('/api/v1/admin/notification-templates/order.accepted').set(bearer(admin)).send({ smsBody: 'Cooper Waters: {{driverName}} is coming with {{shortCode}}.' }).expect(200);
  });

  it('reports and CSV exports', async () => {
    const admin = await adminLogin(h, 'finance');
    const overview = await h.http().get('/api/v1/admin/overview').set(bearer(admin)).expect(200);
    expect(overview.body).toHaveProperty('pending.topups');
    await h.http().get('/api/v1/admin/reports/daily').set(bearer(admin)).expect(200);
    const pay = await h.http().get('/api/v1/admin/reports/payments').set(bearer(admin)).expect(200);
    expect(pay.body).toHaveProperty('cash.amountToea');
    const csv = await h.http().get('/api/v1/admin/reports/orders.csv').set(bearer(admin)).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('short_code');
  });

  it('health endpoint reports DB status', async () => {
    const r = await h.http().get('/health').expect(200);
    expect(r.body.checks.database).toBe('ok');
  });

  it('validation errors use the standard envelope', async () => {
    const c = await customer(h);
    const r = await h.http().post('/api/v1/customer/quote').set(bearer(c.token)).send({ packageId: 'nope', quantity: 0, extra: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_failed');
    expect(Array.isArray(r.body.error.details)).toBe(true);
  });
});
