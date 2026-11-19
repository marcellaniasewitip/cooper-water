import { Harness, startApp, resetDb, approvedDriver, customer, idem, walletBalance, expireRound, CUSTOMER_POINT, DEPOT, adminLogin } from './harness';
import { PLATFORM_OWNER_ID } from '../../src/wallet/ledger.service';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('orders & dispatch (integration)', () => {
  let h: Harness;
  let pkgId: string;

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    const { pkg } = await resetDb(h);
    pkgId = pkg.id;
  });

  async function placeCod(token: string, quantity = 1) {
    const r = await h
      .http()
      .post('/api/v1/customer/orders')
      .set(bearer(token))
      .set('Idempotency-Key', idem())
      .send({ packageId: pkgId, quantity, paymentMethod: 'cod', location: { ...CUSTOMER_POINT, address: 'Lot 5, Boroko', notes: 'Blue gate' } });
    expect(r.status).toBe(201);
    return r.body.order;
  }

  async function driveToDelivered(driverToken: string, orderId: string) {
    const steps: [string, object][] = [
      ['arrive-depot', DEPOT],
      ['loaded', DEPOT],
      ['arrived', CUSTOMER_POINT],
      ['delivered', {}],
    ];
    for (const [step, body] of steps) {
      const r = await h.http().post(`/api/v1/driver/orders/${orderId}/${step}`).set(bearer(driverToken)).send(body);
      expect({ step, status: r.status, body: r.status === 200 ? undefined : r.body }).toEqual({ step, status: 200, body: undefined });
    }
  }

  it('creating an order is idempotent on Idempotency-Key', async () => {
    const c = await customer(h);
    const key = idem();
    const body = { packageId: pkgId, quantity: 2, paymentMethod: 'cod', location: { ...CUSTOMER_POINT, address: 'Lot 5' } };
    const [a, b] = [
      await h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', key).send(body),
      await h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', key).send(body),
    ];
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.order.id).toBe(a.body.order.id);
    expect(await h.prisma.order.count()).toBe(1);
    // Same key, different body → rejected.
    const c2 = await h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', key).send({ ...body, quantity: 3 });
    expect(c2.status).toBe(422);
    // Missing key → rejected.
    const c3 = await h.http().post('/api/v1/customer/orders').set(bearer(c.token)).send(body);
    expect(c3.status).toBe(400);
    expect(c3.body.error.code).toBe('idempotency_key_required');
  });

  it('price and commission are snapshotted on the order', async () => {
    const c = await customer(h);
    const order = await placeCod(c.token, 2);
    expect(order.priceToea).toBe(60000);
    expect(order.commissionToea).toBeUndefined(); // never shown to customers
    await h.prisma.package.update({ where: { id: pkgId }, data: { priceToea: 99999 } });
    await h.settings.set('commission.value', 25, null);
    const row = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.priceToea).toBe(60000);
    expect(row.commissionToea).toBe(6000);
  });

  it('broadcasts offers to eligible nearby drivers only', async () => {
    const near = await approvedDriver(h);
    const broke = await approvedDriver(h, { balanceToea: 100, online: false });
    const offline = await approvedDriver(h, { online: false });
    // Far away (≈ 30 km) driver
    const far = await approvedDriver(h);
    await h.prisma.driver.update({ where: { id: far.driverId }, data: { currentLat: -9.17, currentLng: 147.18 } });
    // Stale location
    const stale = await approvedDriver(h);
    await h.prisma.driver.update({ where: { id: stale.driverId }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });

    const c = await customer(h);
    const order = await placeCod(c.token);
    const offers = await h.prisma.orderOffer.findMany({ where: { orderId: order.id } });
    expect(offers.map((o) => o.driverId)).toEqual([near.driverId]);
    void broke;
    void offline;

    const list = await h.http().get('/api/v1/driver/offers').set(bearer(near.token));
    expect(list.body).toHaveLength(1);
    expect(list.body[0].earningsToea).toBe(30000 - 3000);
  });

  it('concurrent accepts: exactly one driver wins, the rest get order_taken', async () => {
    const drivers = await Promise.all([1, 2, 3, 4, 5].map(() => approvedDriver(h)));
    const c = await customer(h);
    const order = await placeCod(c.token);
    expect(await h.prisma.orderOffer.count({ where: { orderId: order.id } })).toBe(5);

    const results = await Promise.all(
      drivers.map((d) => h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send()),
    );
    const ok = results.filter((r) => r.status === 200);
    const taken = results.filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(taken).toHaveLength(4);
    for (const r of taken) expect(r.body.error.code).toBe('order_taken');

    const row = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('ACCEPTED');
    expect(drivers.map((d) => d.driverId)).toContain(row.driverId);
    expect(await h.prisma.orderEvent.count({ where: { orderId: order.id, toStatus: 'ACCEPTED' } })).toBe(1);
  });

  it('vehicle size: an order only goes to drivers whose tanker matches the ordered size', async () => {
    const small = await h.prisma.package.create({ data: { name: 'Small (1,000 L)', volumeLitres: 1000, priceToea: 8000 } });
    const medium = await h.prisma.package.create({ data: { name: 'Medium (3,000 L)', volumeLitres: 3000, priceToea: 20000 } });
    const d3000 = await approvedDriver(h);
    const d4000 = await approvedDriver(h); // a 4,000 L tank is in the 3,000 L class
    const d5000 = await approvedDriver(h);
    await h.prisma.truck.updateMany({ where: { driverId: d3000.driverId }, data: { capacityLitres: 3000 } });
    await h.prisma.truck.updateMany({ where: { driverId: d4000.driverId }, data: { capacityLitres: 4000 } });

    const types = await h.http().get('/api/v1/driver/vehicle-types').set(bearer(d3000.token)).expect(200);
    expect(types.body.map((t: { capacityLitres: number }) => t.capacityLitres)).toEqual([1000, 3000, 5000]);
    expect(types.body[1]).toMatchObject({ name: '3,000 L water tanker', packages: ['Medium (3,000 L)'] });

    const c = await customer(h);
    const place = (packageId: string) =>
      h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', idem())
        .send({ packageId, quantity: 1, paymentMethod: 'cod', location: { ...CUSTOMER_POINT, address: 'Lot 5, Boroko' } }).expect(201);
    const offeredTo = async (orderId: string) => (await h.prisma.orderOffer.findMany({ where: { orderId } })).map((o) => o.driverId).sort();

    const o3 = (await place(medium.id)).body.order;
    expect(await offeredTo(o3.id)).toEqual([d3000.driverId, d4000.driverId].sort());
    const o5 = (await place(pkgId)).body.order;
    expect(await offeredTo(o5.id)).toEqual([d5000.driverId]);
    const o1 = (await place(small.id)).body.order;
    expect(await offeredTo(o1.id)).toEqual([]); // nobody has a 1,000 L tanker

    // The 5,000 L driver can't grab the 3,000 L order either.
    const acc = await h.http().post(`/api/v1/driver/orders/${o3.id}/accept`).set(bearer(d5000.token)).set('Idempotency-Key', idem()).send();
    expect(acc.status).not.toBe(200);

    // Switching matching off offers to everyone nearby again.
    await h.settings.set('dispatch.match_vehicle_size', false, null);
    const o1b = (await place(small.id)).body.order;
    expect((await offeredTo(o1b.id)).length).toBe(3);
  });

  it('one active order per driver', async () => {
    const d = await approvedDriver(h);
    const c = await customer(h);
    const o1 = await placeCod(c.token);
    const o2 = await placeCod(c.token);
    const a1 = await h.http().post(`/api/v1/driver/orders/${o1.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send();
    expect(a1.status).toBe(200);
    const a2 = await h.http().post(`/api/v1/driver/orders/${o2.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send();
    expect(a2.status).toBe(409);
    expect(a2.body.error.code).toBe('driver_busy');
  });

  it('COD completion deducts commission from the driver wallet and credits the platform', async () => {
    const d = await approvedDriver(h, { balanceToea: 20000 });
    const c = await customer(h);
    const order = await placeCod(c.token);
    const acc = await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send();
    expect(acc.status).toBe(200);
    await driveToDelivered(d.token, order.id);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000); // deduct_at = completion

    const conf = await h.http().post(`/api/v1/customer/orders/${order.id}/confirm`).set(bearer(c.token)).send();
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('COMPLETED');
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000 - 3000);
    expect(await walletBalance(h, 'platform', PLATFORM_OWNER_ID)).toBe(3000);

    // Re-running settlement (e.g. the auto-complete job firing late) never charges twice.
    await h.jobs.run('orders.auto_complete', { orderId: order.id });
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(17000);

    const events = await h.prisma.orderEvent.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.toStatus)).toEqual(['SEARCHING', 'ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'COMPLETED']);
  });

  it('commission at acceptance is deducted on accept and returned if the order is cancelled', async () => {
    await h.settings.set('commission.deduct_at', 'acceptance', null);
    const d = await approvedDriver(h, { balanceToea: 20000 });
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(17000);
    const admin = await adminLogin(h);
    await h.http().post(`/api/v1/admin/orders/${order.id}/cancel`).set(bearer(admin)).send({ reason: 'Customer called' }).expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000);
    expect(await walletBalance(h, 'platform', PLATFORM_OWNER_ID)).toBe(0);
  });

  it('auto-completes delivered orders after the timeout', async () => {
    const d = await approvedDriver(h);
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await driveToDelivered(d.token, order.id);
    // Fired too early → nothing happens.
    await h.jobs.run('orders.auto_complete', { orderId: order.id });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DELIVERED');
    await h.prisma.order.update({ where: { id: order.id }, data: { deliveredAt: new Date(Date.now() - 3 * 3600_000) } });
    await h.jobs.run('orders.auto_complete', { orderId: order.id });
    const done = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(done.status).toBe('COMPLETED');
    expect(done.settledAt).not.toBeNull();
  });

  it('expiry: re-broadcasts with a wider radius, then expires', async () => {
    const c = await customer(h);
    const order = await placeCod(c.token);
    // A driver ~7 km away is outside round 1 (5 km) but inside round 2 (10 km).
    const mid = await approvedDriver(h);
    await h.prisma.driver.update({ where: { id: mid.driverId }, data: { currentLat: CUSTOMER_POINT.lat + 0.063, currentLng: CUSTOMER_POINT.lng } });
    // The order was created before the driver was online at that spot; reset its offers to simulate round 1 without them.
    await h.prisma.orderOffer.deleteMany({ where: { orderId: order.id } });

    await expireRound(h, order.id);
    let row = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('SEARCHING');
    expect(row.dispatchRound).toBe(2);
    expect(await h.prisma.orderOffer.count({ where: { orderId: order.id, round: 2, driverId: mid.driverId } })).toBe(1);

    // A stale timer for round 1 is a no-op (idempotent).
    await h.jobs.run('dispatch.round_timeout', { orderId: order.id, round: 1 });
    // A timer that fires before the window ends is a no-op too.
    await h.jobs.run('dispatch.round_timeout', { orderId: order.id, round: 2 });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('SEARCHING');

    await expireRound(h, order.id);
    row = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe('EXPIRED');
    const missed = await h.prisma.orderOffer.findFirstOrThrow({ where: { orderId: order.id, driverId: mid.driverId } });
    expect(missed.response).toBe('missed');
    // Running it again changes nothing.
    await h.jobs.run('dispatch.round_timeout', { orderId: order.id, round: 2 });
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('EXPIRED');
  });

  it('sweeper catches a missed expiry job', async () => {
    await h.settings.set('order.rebroadcast_rounds', 0, null);
    const c = await customer(h);
    const order = await placeCod(c.token);
    h.jobs.scheduled.splice(0); // the delayed job was "lost"
    await h.prisma.order.update({ where: { id: order.id }, data: { expiresAt: new Date(Date.now() - 120_000) } });
    const counts = await h.app.get((await import('../../src/jobs/sweeper.service')).SweeperService).sweep();
    expect(counts.searching_expired).toBe(1);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('EXPIRED');
  });

  it('customer can cancel only before the configured status', async () => {
    const d = await approvedDriver(h);
    const c = await customer(h);
    const o1 = await placeCod(c.token);
    const r1 = await h.http().post(`/api/v1/customer/orders/${o1.id}/cancel`).set(bearer(c.token)).send({ reason: 'Changed my mind' });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe('CANCELLED');

    const o2 = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${o2.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    const r2 = await h.http().post(`/api/v1/customer/orders/${o2.id}/cancel`).set(bearer(c.token)).send({ reason: 'Too slow' });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('cancel_not_allowed');
  });

  it('loading is geofenced to depots', async () => {
    const d = await approvedDriver(h);
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    const away = await h.http().post(`/api/v1/driver/orders/${order.id}/arrive-depot`).set(bearer(d.token)).send(CUSTOMER_POINT);
    expect(away.status).toBe(422);
    expect(away.body.error.code).toBe('not_at_depot');
    await h.http().post(`/api/v1/driver/orders/${order.id}/arrive-depot`).set(bearer(d.token)).send({ lat: DEPOT.lat + 0.0005, lng: DEPOT.lng }).expect(200);
    // Polygon geofences take precedence over radius.
    const depot = await h.prisma.depot.findFirstOrThrow();
    const ring = [
      [DEPOT.lng - 0.01, DEPOT.lat - 0.01],
      [DEPOT.lng + 0.01, DEPOT.lat - 0.01],
      [DEPOT.lng + 0.01, DEPOT.lat + 0.01],
      [DEPOT.lng - 0.01, DEPOT.lat + 0.01],
      [DEPOT.lng - 0.01, DEPOT.lat - 0.01],
    ];
    await h.prisma.depot.update({ where: { id: depot.id }, data: { geofencePolygon: { type: 'Polygon', coordinates: [ring] } } });
    await h.http().post(`/api/v1/driver/orders/${order.id}/loaded`).set(bearer(d.token)).send({ lat: DEPOT.lat + 0.008, lng: DEPOT.lng + 0.008 }).expect(200);
  });

  it('min balance: a driver below the minimum cannot go online or accept', async () => {
    const d = await approvedDriver(h, { balanceToea: 4999, online: false });
    const r = await h.http().post('/api/v1/driver/online').set(bearer(d.token)).send(DEPOT);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('wallet_below_minimum');
    expect(r.body.error.details).toEqual({ balanceToea: 4999, minBalanceToea: 5000 });

    // Online with enough balance, then the balance drops below the minimum → accept is refused.
    const d2 = await approvedDriver(h, { balanceToea: 6000 });
    const c = await customer(h);
    const order = await placeCod(c.token);
    const w = await h.prisma.wallet.findUniqueOrThrow({ where: { ownerType_ownerId: { ownerType: 'driver', ownerId: d2.driverId } } });
    const admin = await adminLogin(h, 'finance');
    await h.http().post(`/api/v1/admin/wallets/${w.id}/adjustments`).set(bearer(admin)).set('Idempotency-Key', idem()).send({ amountToea: -2000, reason: 'Test debit' }).expect(201);
    const acc = await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d2.token)).set('Idempotency-Key', idem()).send();
    expect(acc.status).toBe(409);
    expect(acc.body.error.code).toBe('wallet_below_minimum');
  });

  it('a commission deduction can push the wallet below the minimum, blocking further jobs', async () => {
    const d = await approvedDriver(h, { balanceToea: 6000 });
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await driveToDelivered(d.token, order.id);
    await h.http().post(`/api/v1/customer/orders/${order.id}/confirm`).set(bearer(c.token)).send().expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(3000);
    const w = await h.http().get('/api/v1/driver/wallet').set(bearer(d.token));
    expect(w.body).toMatchObject({ balanceToea: 3000, blocked: true, shortfallToea: 2000 });
  });

  it('admin reassign releases to dispatch or hands to a named driver', async () => {
    const d1 = await approvedDriver(h);
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d1.token)).set('Idempotency-Key', idem()).send().expect(200);
    const d2 = await approvedDriver(h);
    const admin = await adminLogin(h, 'operations');
    const r = await h.http().post(`/api/v1/admin/orders/${order.id}/reassign`).set(bearer(admin)).send({ driverId: d2.driverId, reason: 'Truck broke down' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ACCEPTED');
    expect(r.body.driver.id).toBe(d2.driverId);
    const back = await h.http().post(`/api/v1/admin/orders/${order.id}/reassign`).set(bearer(admin)).send({ reason: 'Release' });
    expect(back.body.status).toBe('SEARCHING');
    expect(back.body.dispatchRound).toBe(1);
    expect(await h.prisma.auditLog.count({ where: { action: 'order.reassign' } })).toBe(2);
  });

  it('disputes hold settlement until resolved', async () => {
    const d = await approvedDriver(h, { balanceToea: 20000 });
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await driveToDelivered(d.token, order.id);
    const disp = await h.http().post(`/api/v1/customer/orders/${order.id}/disputes`).set(bearer(c.token)).send({ category: 'short_volume', description: 'Only half the tank' });
    expect(disp.status).toBe(201);
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('DISPUTED');
    // Customer can't confirm and auto-complete doesn't settle while disputed.
    expect((await h.http().post(`/api/v1/customer/orders/${order.id}/confirm`).set(bearer(c.token)).send()).status).toBe(409);
    await h.prisma.order.update({ where: { id: order.id }, data: { deliveredAt: new Date(Date.now() - 5 * 3600_000) } });
    await h.jobs.run('orders.auto_complete', { orderId: order.id });
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(20000);

    const admin = await adminLogin(h, 'support');
    const res = await h.http().post(`/api/v1/admin/disputes/${disp.body.id}/resolve`).set(bearer(admin)).send({ decision: 'favour_driver', notes: 'Photo shows full delivery' });
    expect(res.status).toBe(200);
    const done = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(done.status).toBe('COMPLETED');
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(17000);
  });

  it('customers can rate a completed order once', async () => {
    const d = await approvedDriver(h);
    const c = await customer(h);
    const order = await placeCod(c.token);
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    expect((await h.http().post(`/api/v1/customer/orders/${order.id}/rating`).set(bearer(c.token)).send({ stars: 5 })).status).toBe(409);
    await driveToDelivered(d.token, order.id);
    await h.http().post(`/api/v1/customer/orders/${order.id}/confirm`).set(bearer(c.token)).send().expect(200);
    await h.http().post(`/api/v1/customer/orders/${order.id}/rating`).set(bearer(c.token)).send({ stars: 4, comment: 'Good' }).expect(201);
    expect((await h.http().post(`/api/v1/customer/orders/${order.id}/rating`).set(bearer(c.token)).send({ stars: 1 })).status).toBe(409);
    expect((await h.prisma.driver.findUniqueOrThrow({ where: { id: d.driverId } })).ratingAvg).toBe(4);
  });

  it("customers only see their own orders; drivers only their own jobs", async () => {
    const c1 = await customer(h);
    const c2 = await customer(h);
    const d = await approvedDriver(h);
    const order = await placeCod(c1.token);
    expect((await h.http().get(`/api/v1/customer/orders/${order.id}`).set(bearer(c2.token))).status).toBe(404);
    expect((await h.http().get(`/api/v1/driver/orders/${order.id}`).set(bearer(d.token))).status).toBe(404);
    expect((await h.http().get(`/api/v1/driver/offers`).set(bearer(c1.token))).status).toBe(403);
  });
});
