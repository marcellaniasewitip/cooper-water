import { Harness, startApp, resetDb, approvedDriver, customer, idem, walletBalance, expireRound, CUSTOMER_POINT, DEPOT, adminLogin } from './harness';
import { PLATFORM_OWNER_ID } from '../../src/wallet/ledger.service';
import { PaymentsService } from '../../src/payments/payments.service';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('payments, wallets & refunds (integration)', () => {
  let h: Harness;
  let pkgId: string;

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    const { pkg } = await resetDb(h);
    pkgId = pkg.id;
    await h.settings.set('payment.cellmoney.adapter', 'mock', null);
  });

  /** msisdn suffix picks mock behaviour: 1111 succeed now, 0000 fail now, 2222 never resolves, other → webhooks. */
  async function placeCellmoney(token: string, msisdn: string) {
    const r = await h
      .http()
      .post('/api/v1/customer/orders')
      .set(bearer(token))
      .set('Idempotency-Key', idem())
      .send({ packageId: pkgId, quantity: 1, paymentMethod: 'cellmoney', msisdn, location: { ...CUSTOMER_POINT, address: 'Lot 9, Gordons' } });
    expect(r.status).toBe(201);
    return r.body as { order: any; payment: any; paymentError: any };
  }

  function postWebhook(raw: Buffer, headers: Record<string, string>) {
    return h.http().post('/api/v1/webhooks/cellmoney/mock').set(headers).send(raw.toString('utf8'));
  }

  async function deliverAndComplete(driverToken: string, customerToken: string, orderId: string) {
    for (const [step, body] of [['arrive-depot', DEPOT], ['loaded', DEPOT], ['arrived', {}], ['delivered', {}]] as const) {
      await h.http().post(`/api/v1/driver/orders/${orderId}/${step}`).set(bearer(driverToken)).send(body).expect(200);
    }
    await h.http().post(`/api/v1/customer/orders/${orderId}/confirm`).set(bearer(customerToken)).send().expect(200);
  }

  it('duplicate cell money webhooks are applied once', async () => {
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571234567');
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(payment.status).toBe('pending');
    const p = await h.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

    // Same event delivered twice + the same outcome under a different event id (provider retry).
    const evt = h.registry.mock.buildWebhook(p.providerRef!, 'succeeded', p.amountToea, 'evt-1');
    const dup = h.registry.mock.buildWebhook(p.providerRef!, 'succeeded', p.amountToea, 'evt-2');
    const responses = [await postWebhook(evt.rawBody, evt.headers), await postWebhook(evt.rawBody, evt.headers), await postWebhook(dup.rawBody, dup.headers)];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(responses[1].body.duplicate).toBe(true);
    await h.jobs.drain('payments.webhook.process', true);

    const after = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('SEARCHING');
    expect(after.paymentStatus).toBe('paid');
    expect(await h.prisma.orderEvent.count({ where: { orderId: order.id, toStatus: 'SEARCHING' } })).toBe(1);
    expect(await h.prisma.webhookEvent.count({ where: { signatureOk: true } })).toBe(2);
    expect((await h.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('succeeded');
  });

  it('rejects webhooks with a bad signature (and stores them for audit)', async () => {
    const c = await customer(h);
    const { payment } = await placeCellmoney(c.token, '+67571234567');
    const p = await h.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const evt = h.registry.mock.buildWebhook(p.providerRef!, 'succeeded');
    const r = await postWebhook(evt.rawBody, { ...evt.headers, 'x-mock-signature': 'deadbeef' });
    expect(r.status).toBe(401);
    expect(await h.prisma.webhookEvent.count({ where: { signatureOk: false } })).toBe(1);
    expect(h.jobs.scheduled.filter((j) => j.name === 'payments.webhook.process')).toHaveLength(0);
  });

  it('duplicate cell money top-up webhooks credit the wallet once', async () => {
    const d = await approvedDriver(h, { balanceToea: 0, online: false });
    const r = await h.http().post('/api/v1/driver/wallet/topups').set(bearer(d.token)).set('Idempotency-Key', idem()).send({ method: 'cellmoney', amountToea: 10000, msisdn: '+67578887777' });
    expect(r.status).toBe(201);
    const p = await h.prisma.payment.findUniqueOrThrow({ where: { id: r.body.payment.id } });
    for (const id of ['t1', 't1', 't2', 't3']) {
      const evt = h.registry.mock.buildWebhook(p.providerRef!, 'succeeded', p.amountToea, id);
      await postWebhook(evt.rawBody, evt.headers).expect(200);
    }
    await h.jobs.drain('payments.webhook.process', true);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(10000);
    expect((await h.prisma.topupRequest.findFirstOrThrow()).status).toBe('approved');
  });

  it('payment timeout → payment expired, order FAILED', async () => {
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571112222'); // never resolves
    // Webhook never arrives; polling sees "pending".
    await h.jobs.run('payments.poll', { paymentId: payment.id });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PENDING_PAYMENT');
    // Timer fires early → no-op.
    await h.jobs.run('payments.timeout', { paymentId: payment.id });
    expect((await h.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('pending');
    await h.prisma.payment.update({ where: { id: payment.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await h.jobs.run('payments.timeout', { paymentId: payment.id });
    const p = await h.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    const o = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(p.status).toBe('expired');
    expect(o.status).toBe('FAILED');
    expect(o.paymentStatus).toBe('failed');
  });

  it('polling resolves a payment whose webhook never arrived', async () => {
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571112222');
    const p = await h.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    h.registry.mock.setStatus(p.providerRef!, 'succeeded');
    await h.jobs.run('payments.poll', { paymentId: payment.id });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SEARCHING');
  });

  it('an immediate provider failure fails the order', async () => {
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571110000');
    expect(payment.status).toBe('failed');
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('FAILED');
  });

  it('expiry after a successful payment → EXPIRED + refund issued', async () => {
    await h.settings.set('order.rebroadcast_rounds', 0, null);
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571111111'); // succeeds immediately
    expect(payment.status).toBe('succeeded');
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SEARCHING');

    await expireRound(h, order.id);
    let o = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe('EXPIRED');
    expect(o.paymentStatus).toBe('refund_pending');
    const refund = await h.prisma.payment.findFirstOrThrow({ where: { purpose: 'refund', purposeId: order.id } });
    expect(refund).toMatchObject({ direction: 'out', amountToea: 30000, status: 'initiated' });

    await h.jobs.drain('payments.refund.execute', true);
    o = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.paymentStatus).toBe('refunded');
    expect((await h.prisma.payment.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('succeeded');
    // Running the refund job again does nothing.
    await h.jobs.run('payments.refund.execute', { paymentId: refund.id });
    expect(await h.prisma.payment.count({ where: { purpose: 'refund' } })).toBe(1);
  });

  it('cell money completion credits the driver price minus commission', async () => {
    const d = await approvedDriver(h, { balanceToea: 6000 });
    const c = await customer(h);
    const { order } = await placeCellmoney(c.token, '+67571111111');
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await deliverAndComplete(d.token, c.token, order.id);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(6000 + 30000 - 3000);
    expect(await walletBalance(h, 'platform', PLATFORM_OWNER_ID)).toBe(3000);
    const entries = await h.prisma.ledgerEntry.findMany({ where: { referenceId: order.id } });
    expect(entries.map((e) => [e.type, e.amountToea]).sort()).toEqual([['commission', 3000], ['order_earning', 27000]].sort());
  });

  it('fee bearer = driver: the fee is taken from driver earnings', async () => {
    await h.settings.set('payment.cellmoney.fee_percent', 2, null);
    await h.settings.set('payment.cellmoney.fee_bearer', 'driver', null);
    const d = await approvedDriver(h, { balanceToea: 6000 });
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571111111');
    expect(payment).toMatchObject({ amountToea: 30000, feeToea: 600 });
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await deliverAndComplete(d.token, c.token, order.id);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(6000 + 30000 - 3000 - 600);
  });

  it('fee bearer = customer: the customer is charged price + fee', async () => {
    await h.settings.set('payment.cellmoney.fee_percent', 1.5, null);
    await h.settings.set('payment.cellmoney.fee_bearer', 'customer', null);
    const c = await customer(h);
    const { payment } = await placeCellmoney(c.token, '+67571111111');
    expect(payment).toMatchObject({ amountToea: 30450, feeToea: 450 });
  });

  it('manual adapter: admin confirms by reference; a late payment on a dead order is refunded', async () => {
    await h.settings.set('payment.cellmoney.adapter', 'manual', null);
    await h.settings.set('payment.cellmoney.merchant_number', '7000 1234', null);
    const c = await customer(h);
    const first = await placeCellmoney(c.token, '+67571234567');
    expect(first.payment.manual).toBe(true);
    expect(first.payment.instructions).toContain(first.order.shortCode);
    expect(first.payment.instructions).toContain('7000 1234');
    const finance = await adminLogin(h, 'finance');
    const ok = await h.http().post(`/api/v1/admin/payments/${first.payment.id}/confirm`).set(bearer(finance)).send({ receiptRef: 'MM12345' });
    expect(ok.status).toBe(200);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).status).toBe('SEARCHING');
    expect(await h.prisma.auditLog.count({ where: { action: 'payment.confirm' } })).toBe(1);

    // Second order times out, then the money turns up and Finance confirms it anyway.
    const second = await placeCellmoney(c.token, '+67571234567');
    await h.prisma.payment.update({ where: { id: second.payment.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await h.jobs.run('payments.timeout', { paymentId: second.payment.id });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: second.order.id } })).status).toBe('FAILED');
    await h.http().post(`/api/v1/admin/payments/${second.payment.id}/confirm`).set(bearer(finance)).send({ receiptRef: 'MM999' }).expect(200);
    const o = await h.prisma.order.findUniqueOrThrow({ where: { id: second.order.id } });
    expect(o.status).toBe('FAILED');
    expect(o.paymentStatus).toBe('refund_pending');
    // Manual provider can't refund by API → stays as a manual task until Finance completes it.
    await h.jobs.drain('payments.refund.execute', true);
    const refund = await h.prisma.payment.findFirstOrThrow({ where: { purpose: 'refund', purposeId: second.order.id } });
    expect(refund.status).toBe('pending');
    await h.http().post(`/api/v1/admin/payments/${refund.id}/complete-refund`).set(bearer(finance)).send({ externalRef: 'MMREF-1' }).expect(204);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: second.order.id } })).paymentStatus).toBe('refunded');
  });

  it('support cannot confirm payments (RBAC)', async () => {
    await h.settings.set('payment.cellmoney.adapter', 'manual', null);
    const c = await customer(h);
    const { payment } = await placeCellmoney(c.token, '+67571234567');
    const support = await adminLogin(h, 'support');
    const r = await h.http().post(`/api/v1/admin/payments/${payment.id}/confirm`).set(bearer(support)).send({ receiptRef: 'x' });
    expect(r.status).toBe(403);
  });

  it('bank top-up: pending until approved, then credited once', async () => {
    const d = await approvedDriver(h, { balanceToea: 0, online: false });
    const key = idem();
    const body = { method: 'bank_transfer', amountToea: 15000, referenceText: 'BSP 0042' };
    const r1 = await h.http().post('/api/v1/driver/wallet/topups').set(bearer(d.token)).set('Idempotency-Key', key).send(body);
    const r2 = await h.http().post('/api/v1/driver/wallet/topups').set(bearer(d.token)).set('Idempotency-Key', key).send(body);
    expect(r1.body.topup.id).toBe(r2.body.topup.id);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(0);
    const finance = await adminLogin(h, 'finance');
    const a1 = await h.http().post(`/api/v1/admin/topups/${r1.body.topup.id}/approve`).set(bearer(finance)).send();
    expect(a1.status).toBe(200);
    const a2 = await h.http().post(`/api/v1/admin/topups/${r1.body.topup.id}/approve`).set(bearer(finance)).send();
    expect(a2.status).toBe(409);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(15000);
    expect(await h.prisma.auditLog.count({ where: { action: 'topup.approve' } })).toBe(1);
  });

  it('withdrawals: nothing is deducted at request; an admin deducts it manually from the wallet, once', async () => {
    const d = await approvedDriver(h, { balanceToea: 20000, online: false });
    const send = (amountToea: number, extra: Record<string, unknown> = {}) =>
      h.http().post('/api/v1/driver/wallet/withdrawals').set(bearer(d.token)).set('Idempotency-Key', idem()).send({ amountToea, method: 'cellmoney', destination: '+67571234567', ...extra });

    const tooMuch = await send(15001);
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe('insufficient_balance');
    const ok = await send(10000);
    expect(ok.status).toBe(201);
    // Not deducted: the balance stays until an admin deducts it.
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000);
    const summary = (await h.http().get('/api/v1/driver/wallet').set(bearer(d.token)).expect(200)).body;
    expect(summary).toMatchObject({ balanceToea: 20000, withdrawableToea: 5000, pendingPayouts: { count: 1, amountToea: 10000 } });
    // The waiting request still counts: can't request the same money twice.
    expect((await send(6000)).body.error.code).toBe('insufficient_balance');

    const finance = await adminLogin(h, 'finance');
    const queue = (await h.http().get('/api/v1/admin/payouts?status=requested').set(bearer(finance)).expect(200)).body.items;
    expect(queue[0]).toMatchObject({ id: ok.body.id, deducted: false, walletBalanceToea: 20000 });
    const walletId = queue[0].walletId;

    // Approve with a note (the admin dashboard flow), then pay.
    await h.http().post(`/api/v1/admin/payouts/${ok.body.id}/approve`).set(bearer(finance)).send({ notes: 'Checked with driver' }).expect(200);
    await h.http().post(`/api/v1/admin/payouts/${ok.body.id}/paid`).set(bearer(finance)).send({}).expect(422); // ref required
    await h.http().post(`/api/v1/admin/payouts/${ok.body.id}/paid`).set(bearer(finance)).send({ externalRef: 'MP-TX-77' }).expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000); // still manual

    // Manual deduction from the driver's wallet, linked to the withdrawal.
    const adjust = (body: Record<string, unknown>) => h.http().post(`/api/v1/admin/wallets/${walletId}/adjustments`).set(bearer(finance)).set('Idempotency-Key', idem()).send(body);
    expect((await adjust({ amountToea: -5000, reason: 'Withdrawal paid MP-TX-77', payoutId: ok.body.id })).body.error.code).toBe('payout_amount_mismatch');
    await adjust({ amountToea: -10000, reason: 'Withdrawal paid MP-TX-77', payoutId: ok.body.id }).expect(201);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(10000);
    expect((await adjust({ amountToea: -10000, reason: 'Again', payoutId: ok.body.id })).body.error.code).toBe('payout_already_deducted');
    const paid = (await h.http().get('/api/v1/admin/payouts?status=paid').set(bearer(finance)).expect(200)).body.items;
    expect(paid[0]).toMatchObject({ deducted: true, notes: 'Checked with driver' });
    expect((await h.http().get('/api/v1/driver/wallet').set(bearer(d.token))).body).toMatchObject({ withdrawableToea: 5000, pendingPayouts: { count: 0 } });
    expect(await h.prisma.payment.count({ where: { purpose: 'payout', status: 'succeeded' } })).toBe(1);

    // Rejecting a request that was never deducted gives nothing back (nothing was taken).
    const other = await send(3000);
    await h.http().post(`/api/v1/admin/payouts/${other.body.id}/reject`).set(bearer(finance)).send({ notes: 'Wrong number' }).expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(10000);
    expect((await adjust({ amountToea: -3000, reason: 'Rejected one', payoutId: other.body.id })).body.error.code).toBe('payout_state');
  });

  it('withdrawals made before this change (already deducted) are returned when rejected', async () => {
    const d = await approvedDriver(h, { balanceToea: 20000, online: false });
    const ok = await h.http().post('/api/v1/driver/wallet/withdrawals').set(bearer(d.token)).set('Idempotency-Key', idem()).send({ amountToea: 8000, method: 'cellmoney', destination: '+67571234567' }).expect(201);
    // Simulate the old automatic deduction.
    const w = await h.prisma.wallet.findUniqueOrThrow({ where: { ownerType_ownerId: { ownerType: 'driver', ownerId: d.driverId } } });
    await h.prisma.ledgerEntry.create({ data: { walletId: w.id, amountToea: -8000, balanceAfter: 12000, type: 'payout', referenceType: 'payout', referenceId: ok.body.id, idempotencyKey: `payout:${ok.body.id}`, createdBy: 'test' } });
    await h.prisma.wallet.update({ where: { id: w.id }, data: { balanceToea: 12000 } });
    expect((await h.http().get('/api/v1/driver/wallet').set(bearer(d.token))).body).toMatchObject({ withdrawableToea: 7000, pendingPayouts: { count: 0 } });
    const finance = await adminLogin(h, 'finance');
    await h.http().post(`/api/v1/admin/payouts/${ok.body.id}/reject`).set(bearer(finance)).send({ notes: 'Duplicate' }).expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000);
  });

  it('dispute resolved for the customer after delivery: refund + clawback from the driver', async () => {
    const d = await approvedDriver(h, { balanceToea: 6000 });
    const c = await customer(h);
    const { order } = await placeCellmoney(c.token, '+67571111111');
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await deliverAndComplete(d.token, c.token, order.id);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(33000);
    const disp = await h.http().post(`/api/v1/customer/orders/${order.id}/disputes`).set(bearer(c.token)).send({ category: 'quality', description: 'Dirty water' }).expect(201);
    const ops = await adminLogin(h, 'operations');
    await h.http().post(`/api/v1/admin/disputes/${disp.body.id}/resolve`).set(bearer(ops)).send({ decision: 'favour_customer', notes: 'Confirmed by photo', refundToea: 10000 }).expect(200);
    const o = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(o.status).toBe('COMPLETED');
    expect(o.paymentStatus).toBe('refund_pending');
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(23000);
    await h.jobs.drain('payments.refund.execute', true);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).paymentStatus).toBe('refunded');
  });

  it('ledger is append-only at the database level', async () => {
    const d = await approvedDriver(h, { balanceToea: 1000, online: false });
    const entry = await h.prisma.ledgerEntry.findFirstOrThrow({ where: { referenceId: d.driverId } });
    await expect(h.prisma.ledgerEntry.update({ where: { id: entry.id }, data: { amountToea: 999999 } })).rejects.toThrow(/append-only/);
    await expect(h.prisma.ledgerEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
  });

  it('applyStatus is idempotent under concurrency', async () => {
    const c = await customer(h);
    const { order, payment } = await placeCellmoney(c.token, '+67571112222');
    const svc = h.app.get(PaymentsService);
    await Promise.all([1, 2, 3, 4].map(() => svc.applyStatus(payment.id, 'succeeded', { source: 'test' })));
    expect(await h.prisma.orderEvent.count({ where: { orderId: order.id, toStatus: 'SEARCHING' } })).toBe(1);
  });
});
