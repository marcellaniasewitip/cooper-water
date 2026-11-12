import { Harness, startApp, resetDb, approvedDriver, customer, idem, walletBalance, adminLogin, CUSTOMER_POINT, DEPOT } from './harness';
import { PLATFORM_OWNER_ID } from '../../src/wallet/ledger.service';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('customer wallet, offers, referrals, inbox and chat (integration)', () => {
  let h: Harness;
  let pkgId: string; // 5000 L at K300.00

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    const { pkg } = await resetDb(h);
    pkgId = pkg.id;
  });

  const location = { ...CUSTOMER_POINT, address: 'Lot 5, Boroko' };

  async function order(token: string, body: Record<string, unknown> = {}) {
    return h.http().post('/api/v1/customer/orders').set(bearer(token)).set('Idempotency-Key', idem()).send({ packageId: pkgId, quantity: 1, paymentMethod: 'cod', location, ...body });
  }

  async function topUp(token: string, amountToea: number, method = 'cash') {
    const t = await h.http().post('/api/v1/customer/wallet/topups').set(bearer(token)).set('Idempotency-Key', idem()).send({ method, amountToea, referenceText: 'RCPT-1' }).expect(201);
    const admin = await adminLogin(h);
    await h.http().post(`/api/v1/admin/topups/${t.body.id}/approve`).set(bearer(admin)).send({}).expect(200);
    return t.body;
  }

  async function complete(driverToken: string, customerToken: string, orderId: string) {
    await h.http().post(`/api/v1/driver/orders/${orderId}/accept`).set(bearer(driverToken)).set('Idempotency-Key', idem()).send().expect(200);
    for (const [step, body] of [['arrive-depot', DEPOT], ['loaded', DEPOT], ['arrived', CUSTOMER_POINT], ['delivered', {}]] as const) {
      await h.http().post(`/api/v1/driver/orders/${orderId}/${step}`).set(bearer(driverToken)).send(body).expect(200);
    }
    await h.http().post(`/api/v1/customer/orders/${orderId}/confirm`).set(bearer(customerToken)).send().expect(200);
  }

  it('cash/bank/cell money top-ups are approved by an admin and can pay for an order; cancelling refunds the wallet', async () => {
    const c = await customer(h);
    for (const method of ['cash', 'bank_transfer', 'cellmoney']) {
      await h.http().post('/api/v1/customer/wallet/topups').set(bearer(c.token)).set('Idempotency-Key', idem()).send({ method, amountToea: 1000, referenceText: 'X' }).expect(201);
    }
    const admin = await adminLogin(h);
    const queue = await h.http().get('/api/v1/admin/topups?status=pending').set(bearer(admin)).expect(200);
    expect(queue.body.items).toHaveLength(3);
    expect(queue.body.items[0].customer.phone).toBeTruthy();

    // Not enough money yet.
    const short = await order(c.token, { paymentMethod: 'wallet' });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('wallet_insufficient');

    await topUp(c.token, 40000);
    expect((await h.http().get('/api/v1/customer/wallet').set(bearer(c.token)).expect(200)).body).toMatchObject({ balanceToea: 40000, pendingTopups: { count: 3 } });

    const paid = await order(c.token, { paymentMethod: 'wallet' });
    expect(paid.status).toBe(201);
    expect(paid.body.order).toMatchObject({ status: 'SEARCHING', paymentStatus: 'paid', paymentMethod: 'wallet', payableToea: 30000 });
    expect(await walletBalance(h, 'customer', c.userId)).toBe(10000);

    await h.http().post(`/api/v1/customer/orders/${paid.body.order.id}/cancel`).set(bearer(c.token)).send({ reason: 'Changed my mind' }).expect(200);
    expect(await walletBalance(h, 'customer', c.userId)).toBe(40000);
    const entries = await h.http().get('/api/v1/customer/wallet/entries').set(bearer(c.token)).expect(200);
    expect(entries.body.items.map((e: any) => e.type)).toEqual(['refund', 'order_payment', 'topup']);
  });

  it('drivers can top up by cash too (admin approves)', async () => {
    const d = await approvedDriver(h, { balanceToea: 0, online: false });
    const t = await h.http().post('/api/v1/driver/wallet/topups').set(bearer(d.token)).set('Idempotency-Key', idem()).send({ method: 'cash', amountToea: 5000, referenceText: 'RCPT-9' }).expect(201);
    expect(t.body.topup).toMatchObject({ method: 'cash', status: 'pending' });
    const admin = await adminLogin(h);
    await h.http().post(`/api/v1/admin/topups/${t.body.topup.id}/approve`).set(bearer(admin)).send({}).expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(5000);
  });

  it('a wallet-paid order settles the driver from the full price', async () => {
    const c = await customer(h);
    const d = await approvedDriver(h);
    await topUp(c.token, 30000);
    const o = (await order(c.token, { paymentMethod: 'wallet' })).body.order;
    const before = await walletBalance(h, 'driver', d.driverId);
    await complete(d.token, c.token, o.id);
    // K300 price, 10% commission → driver earns K270.
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(before + 27000);
    expect(await walletBalance(h, 'customer', c.userId)).toBe(0);
  });

  it('promo codes: discount at quote and order, one use per customer, platform pays the COD driver the discount', async () => {
    const admin = await adminLogin(h);
    await h.http().post('/api/v1/admin/promos').set(bearer(admin)).send({ code: 'water10', discountType: 'percent', discountValue: 10, description: '10% off' }).expect(201);
    const c = await customer(h);
    const offers = await h.http().get('/api/v1/customer/offers').set(bearer(c.token)).expect(200);
    expect(offers.body).toMatchObject([{ code: 'WATER10', usable: true }]);
    await h.http().post('/api/v1/customer/offers/check').set(bearer(c.token)).send({ code: 'Water10' }).expect(200);
    expect((await h.http().post('/api/v1/customer/offers/check').set(bearer(c.token)).send({ code: 'NOPE1' })).body.error.code).toBe('promo_not_found');

    const q = await h.http().post('/api/v1/customer/quote').set(bearer(c.token)).send({ packageId: pkgId, quantity: 1, promoCode: 'WATER10' }).expect(200);
    expect(q.body).toMatchObject({ priceToea: 30000, discountToea: 3000, payableToea: 27000, promo: { code: 'WATER10' } });

    const d = await approvedDriver(h);
    const platformBefore = await walletBalance(h, 'platform', PLATFORM_OWNER_ID);
    const driverBefore = await walletBalance(h, 'driver', d.driverId);
    const o = (await order(c.token, { promoCode: 'WATER10' })).body.order;
    expect(o).toMatchObject({ discountToea: 3000, payableToea: 27000 });
    expect((await order(c.token, { promoCode: 'WATER10' })).body.error.code).toBe('promo_already_used');

    await complete(d.token, c.token, o.id);
    // Driver: −K30 commission + K30 discount top-up (collected K270 cash instead of K300).
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(driverBefore);
    // Platform: +K30 commission − K30 discount.
    expect(await walletBalance(h, 'platform', PLATFORM_OWNER_ID)).toBe(platformBefore);
  });

  it('a cancelled order gives the promo use back', async () => {
    const admin = await adminLogin(h);
    await h.http().post('/api/v1/admin/promos').set(bearer(admin)).send({ code: 'K20OFF', discountType: 'flat', discountValue: 2000 }).expect(201);
    const c = await customer(h);
    const o = (await order(c.token, { promoCode: 'K20OFF' })).body.order;
    expect(o.payableToea).toBe(28000);
    await h.http().post(`/api/v1/customer/orders/${o.id}/cancel`).set(bearer(c.token)).send({ reason: 'test' }).expect(200);
    expect((await order(c.token, { promoCode: 'K20OFF' })).status).toBe(201);
  });

  it('refer & earn: both customers get wallet credit after the first completed order', async () => {
    const referrer = await customer(h);
    const code = (await h.http().get('/api/v1/customer/referral').set(bearer(referrer.token)).expect(200)).body.code;
    expect(code).toMatch(/^CW[A-Z2-9]{6}$/);
    const friend = await customer(h);
    expect((await h.http().post('/api/v1/customer/referral/apply').set(bearer(friend.token)).send({ code: 'CWNOTREAL' })).body.error.code).toBe('referral_not_found');
    expect((await h.http().post('/api/v1/customer/referral/apply').set(bearer(referrer.token)).send({ code })).body.error.code).toBe('referral_self');
    const applied = await h.http().post('/api/v1/customer/referral/apply').set(bearer(friend.token)).send({ code: code.toLowerCase() }).expect(200);
    expect(applied.body).toMatchObject({ canApplyCode: false, referredByCode: code });

    const d = await approvedDriver(h);
    const o = (await order(friend.token)).body.order;
    await complete(d.token, friend.token, o.id);
    expect(await walletBalance(h, 'customer', friend.userId)).toBe(1000);
    expect(await walletBalance(h, 'customer', referrer.userId)).toBe(1000);
    // Only once.
    const o2 = (await order(friend.token)).body.order;
    await complete(d.token, friend.token, o2.id);
    expect(await walletBalance(h, 'customer', friend.userId)).toBe(1000);
    expect((await h.http().get('/api/v1/customer/referral').set(bearer(referrer.token))).body).toMatchObject({ invitedCount: 1, rewardedCount: 1, earnedToea: 1000 });
  });

  it('a Refer & Earn code typed in the promo box is recognised (not "not valid")', async () => {
    const referrer = await customer(h);
    const friend = await customer(h);
    const code = (await h.http().get('/api/v1/customer/referral').set(bearer(referrer.token)).expect(200)).body.code;
    const check = await h.http().post('/api/v1/customer/offers/check').set(bearer(friend.token)).send({ code });
    expect(check.status).toBe(422);
    expect(check.body.error.code).toBe('promo_is_referral');
    const quote = await h.http().post('/api/v1/customer/quote').set(bearer(friend.token)).send({ packageId: pkgId, quantity: 1, promoCode: code });
    expect(quote.body.error.code).toBe('promo_is_referral');
    // The app then applies it as a referral.
    await h.http().post('/api/v1/customer/referral/apply').set(bearer(friend.token)).send({ code }).expect(200);
  });

  it('inbox lists the customer’s notifications, newest first', async () => {
    const c = await customer(h);
    await topUp(c.token, 5000);
    const inbox = await h.http().get('/api/v1/customer/inbox').set(bearer(c.token)).expect(200);
    expect(inbox.body.items[0]).toMatchObject({ template: 'topup.approved', title: 'Top-up approved' });
    expect(inbox.body.items.every((i: any) => i.template !== 'auth.otp')).toBe(true);
  });

  it('chat: customer and driver message each other on an active order; it closes when the order is finished', async () => {
    const c = await customer(h);
    const d = await approvedDriver(h);
    const o = (await order(c.token)).body.order;
    expect((await h.http().post(`/api/v1/customer/orders/${o.id}/messages`).set(bearer(c.token)).send({ body: 'hi' })).body.error.code).toBe('chat_no_driver');
    await h.http().post(`/api/v1/driver/orders/${o.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);

    await h.http().post(`/api/v1/customer/orders/${o.id}/messages`).set(bearer(c.token)).send({ body: 'Blue gate, please honk' }).expect(201);
    const driverChats = await h.http().get('/api/v1/driver/chats').set(bearer(d.token)).expect(200);
    expect(driverChats.body[0]).toMatchObject({ orderId: o.id, unread: 1, lastMessage: { body: 'Blue gate, please honk', mine: false } });
    const thread = await h.http().get(`/api/v1/driver/orders/${o.id}/messages`).set(bearer(d.token)).expect(200);
    expect(thread.body).toMatchObject({ open: true, messages: [{ body: 'Blue gate, please honk', mine: false, senderRole: 'customer' }] });
    expect((await h.http().get('/api/v1/driver/chats').set(bearer(d.token))).body[0].unread).toBe(0);
    await h.http().post(`/api/v1/driver/orders/${o.id}/messages`).set(bearer(d.token)).send({ body: 'On my way' }).expect(201);

    // Someone else's order is invisible.
    const other = await customer(h);
    expect((await h.http().get(`/api/v1/customer/orders/${o.id}/messages`).set(bearer(other.token))).status).toBe(404);

    const admin = await adminLogin(h);
    const transcript = await h.http().get(`/api/v1/admin/orders/${o.id}/messages`).set(bearer(admin)).expect(200);
    expect(transcript.body.map((m: any) => m.senderRole)).toEqual(['customer', 'driver']);

    for (const [step, body] of [['arrive-depot', DEPOT], ['loaded', DEPOT], ['arrived', CUSTOMER_POINT], ['delivered', {}]] as const) {
      await h.http().post(`/api/v1/driver/orders/${o.id}/${step}`).set(bearer(d.token)).send(body).expect(200);
    }
    await h.http().post(`/api/v1/customer/orders/${o.id}/confirm`).set(bearer(c.token)).send().expect(200);
    expect((await h.http().post(`/api/v1/customer/orders/${o.id}/messages`).set(bearer(c.token)).send({ body: 'thanks' })).body.error.code).toBe('chat_closed');
  });
});
