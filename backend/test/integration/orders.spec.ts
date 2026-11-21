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

  it('vehicle size: an order only goes to trucks of exactly the ordered size (not smaller or bigger)', async () => {
    const small = await h.prisma.package.create({ data: { name: 'Small (1,000 L)', volumeLitres: 1000, priceToea: 8000 } });
    const medium = await h.prisma.package.create({ data: { name: 'Medium (3,000 L)', volumeLitres: 3000, priceToea: 20000 } });
    const d3000 = await approvedDriver(h);
    const d4000 = await approvedDriver(h); // 4,000 L: no package of that size, so it gets nothing
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
    expect(await offeredTo(o3.id)).toEqual([d3000.driverId]); // exact size only
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

  it('zones: an order inside a zone only goes to drivers whose live location is inside that zone', async () => {
    const admin = await adminLogin(h);
    // A box around the customer's area that leaves the depot outside.
    const box = { type: 'Polygon', coordinates: [[[147.183, -9.45], [147.188, -9.45], [147.188, -9.445], [147.183, -9.445], [147.183, -9.45]]] };
    const z = await h.http().post('/api/v1/admin/zones').set(bearer(admin)).send({ name: 'Boroko', polygon: box }).expect(201);
    expect(z.body).toMatchObject({ name: 'Boroko', active: true });
    await h.http().post('/api/v1/admin/zones').set(bearer(admin)).send({ name: 'Bad', polygon: { type: 'Polygon', coordinates: [[[1, 1]]] } }).expect(422);

    const inside = await approvedDriver(h);
    const outside = await approvedDriver(h); // stays at the depot, outside the zone
    await h.prisma.driver.update({ where: { id: inside.driverId }, data: { currentLat: -9.447, currentLng: 147.186, lastSeenAt: new Date() } });

    const c = await customer(h);
    const place = (point: { lat: number; lng: number }) =>
      h.http().post('/api/v1/customer/orders').set(bearer(c.token)).set('Idempotency-Key', idem())
        .send({ packageId: pkgId, quantity: 1, paymentMethod: 'cod', location: { ...point, address: 'Somewhere' } }).expect(201);
    const offeredTo = async (orderId: string) => (await h.prisma.orderOffer.findMany({ where: { orderId } })).map((o) => o.driverId).sort();

    const inZone = (await place(CUSTOMER_POINT)).body.order;
    expect(await offeredTo(inZone.id)).toEqual([inside.driverId]);
    // Outside every zone: the normal radius rule (both drivers are near).
    const noZone = (await place({ lat: -9.4425, lng: 147.1795 })).body.order;
    expect(await offeredTo(noZone.id)).toEqual([inside.driverId, outside.driverId].sort());

    // Zone switched off (or the restriction disabled): back to everyone nearby.
    await h.http().patch(`/api/v1/admin/zones/${z.body.id}`).set(bearer(admin)).send({ active: false }).expect(200);
    const again = (await place(CUSTOMER_POINT)).body.order;
    expect(await offeredTo(again.id)).toEqual([inside.driverId, outside.driverId].sort());
    const list = await h.http().get('/api/v1/admin/zones').set(bearer(admin)).expect(200);
    expect(list.body).toHaveLength(1);
    await h.http().delete(`/api/v1/admin/zones/${z.body.id}`).set(bearer(admin)).expect(204);
  });

  it('auto-assign: the order is placed with the nearest driver; decline or timeout moves it to the next', async () => {
    await h.settings.set('dispatch.auto_assign', true, null);
    const near = await approvedDriver(h);
    const far = await approvedDriver(h); // stays at the depot
    await h.prisma.driver.update({ where: { id: near.driverId }, data: { currentLat: CUSTOMER_POINT.lat + 0.0005, currentLng: CUSTOMER_POINT.lng, lastSeenAt: new Date() } });
    const offers = (orderId: string) => h.prisma.orderOffer.findMany({ where: { orderId }, orderBy: { sentAt: 'asc' } });
    const c = await customer(h);

    // 1. Placed with the nearest driver only.
    const o1 = await placeCod(c.token);
    let list = await offers(o1.id);
    expect(list.map((o) => [o.driverId, o.response])).toEqual([[near.driverId, null]]);
    expect(h.jobs.scheduled.some((j) => j.name === 'dispatch.auto_next' && j.data.offerId === list[0].id)).toBe(true);
    const placed = await h.prisma.notification.findFirst({ where: { userId: c.userId, template: 'order.auto_assigned' } });
    expect(placed).not.toBeNull();

    // 2. The nearest declines: it goes straight to the next nearest.
    await h.http().post(`/api/v1/driver/orders/${o1.id}/decline`).set(bearer(near.token)).set('Idempotency-Key', idem()).send().expect(204);
    list = await offers(o1.id);
    expect(list.map((o) => [o.driverId, o.response])).toEqual([[near.driverId, 'declined'], [far.driverId, null]]);

    // 3. The next one does not answer in time: taken back, and nobody else is left.
    await h.jobs.run('dispatch.auto_next', { orderId: o1.id, offerId: list[1].id });
    list = await offers(o1.id);
    expect(list.map((o) => o.response)).toEqual(['declined', 'missed']);
    const late = await h.http().post(`/api/v1/driver/orders/${o1.id}/accept`).set(bearer(far.token)).set('Idempotency-Key', idem()).send();
    expect(late.status).toBe(409);
    // A stale timer for an answered offer does nothing.
    await h.jobs.run('dispatch.auto_next', { orderId: o1.id, offerId: list[1].id });
    expect(await offers(o1.id)).toHaveLength(2);

    // 4. A new order: the nearest accepts.
    const o2 = await placeCod(c.token);
    expect((await offers(o2.id)).map((o) => o.driverId)).toEqual([near.driverId]);
    await h.http().post(`/api/v1/driver/orders/${o2.id}/accept`).set(bearer(near.token)).set('Idempotency-Key', idem()).send().expect(200);
  });

  it('corporate account: employees order on account, debited to the company up to its credit limit, monthly statement', async () => {
    const admin = await adminLogin(h);
    const co = await h.http().post('/api/v1/admin/companies').set(bearer(admin))
      .send({ name: 'Acme PNG Ltd', contactEmail: 'Accounts@Acme.example', creditLimitToea: 50000 }).expect(201);
    expect(co.body).toMatchObject({ name: 'Acme PNG Ltd', contactEmail: 'accounts@acme.example', balanceToea: 0, availableToea: 50000 });
    const companyId = co.body.id;

    const emp = await customer(h);
    const outsider = await customer(h);
    const phone = (await h.prisma.user.findUniqueOrThrow({ where: { id: emp.userId } })).phone;
    await h.http().post(`/api/v1/admin/companies/${companyId}/employees`).set(bearer(admin)).send({ phone: '+675 70000000' }).expect(404);
    await h.http().post(`/api/v1/admin/companies/${companyId}/employees`).set(bearer(admin)).send({ phone }).expect(201);

    // The app offers "Company account" only to employees.
    const cfg = await h.http().get('/api/v1/customer/config').set(bearer(emp.token)).expect(200);
    expect(cfg.body.paymentMethods).toContain('account');
    expect(cfg.body.company).toMatchObject({ name: 'Acme PNG Ltd', availableToea: 50000 });
    const cfg2 = await h.http().get('/api/v1/customer/config').set(bearer(outsider.token)).expect(200);
    expect(cfg2.body.paymentMethods).not.toContain('account');
    expect(cfg2.body.company).toBeNull();

    const place = (token: string) =>
      h.http().post('/api/v1/customer/orders').set(bearer(token)).set('Idempotency-Key', idem())
        .send({ packageId: pkgId, quantity: 1, paymentMethod: 'account', location: { ...CUSTOMER_POINT, address: 'Acme yard' } });
    expect((await place(outsider.token)).status).toBe(422);

    // K300 order: debited straight away.
    const d = await approvedDriver(h);
    const r1 = await place(emp.token);
    expect(r1.status).toBe(201);
    const o1 = r1.body.order;
    expect(o1.paymentStatus).toBe('paid');
    expect((await h.prisma.order.findUniqueOrThrow({ where: { id: o1.id } })).companyId).toBe(companyId);
    expect(await walletBalance(h, 'company' as any, companyId)).toBe(-30000);

    // Only K200 of credit left: a second K300 order is refused.
    const r2 = await place(emp.token);
    expect(r2.status).toBe(422);
    expect(r2.body.error.code).toBe('credit_limit_reached');

    // Delivered + confirmed: the driver is paid (price minus commission) like any prepaid order.
    const before = await walletBalance(h, 'driver', d.driverId);
    await h.http().post(`/api/v1/driver/orders/${o1.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await driveToDelivered(d.token, o1.id);
    await h.http().post(`/api/v1/customer/orders/${o1.id}/confirm`).set(bearer(emp.token)).send().expect(200);
    expect(await walletBalance(h, 'driver', d.driverId)).toBe(before + 30000 - 3000);

    // The company pays its bill.
    await h.http().post(`/api/v1/admin/companies/${companyId}/payments`).set(bearer(admin)).set('Idempotency-Key', idem())
      .send({ amountToea: 20000, reference: 'BSP transfer 123' }).expect(201);
    expect(await walletBalance(h, 'company' as any, companyId)).toBe(-10000);

    // A cancelled account order gives the charge back.
    const r3 = await place(emp.token);
    expect(r3.status).toBe(201);
    await h.http().post(`/api/v1/customer/orders/${r3.body.order.id}/cancel`).set(bearer(emp.token)).send({ reason: 'Changed plans' }).expect(200);
    expect(await walletBalance(h, 'company' as any, companyId)).toBe(-10000);

    // Month totals (live) and the CSV.
    const month = new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 7);
    const sum = await h.http().get(`/api/v1/admin/companies/${companyId}/months/${month}`).set(bearer(admin)).expect(200);
    expect(sum.body).toMatchObject({ orderCount: 1, litres: 5000, chargedToea: 30000, paymentsToea: 20000, openingBalanceToea: 0, closingBalanceToea: -10000 });
    const csv = await h.http().get(`/api/v1/admin/companies/${companyId}/months/${month}/orders.csv`).set(bearer(admin)).expect(200);
    expect(csv.text).toContain(o1.shortCode);
    expect(csv.text.split('\r\n').filter(Boolean)).toHaveLength(3); // header + delivered + cancelled

    // Month end: the sweeper writes the statement once.
    const nextMonth = new Date(Date.now() + 40 * 24 * 3600_000);
    await h.jobs.run('companies.close_months', { at: nextMonth.toISOString() });
    await h.jobs.run('companies.close_months', { at: nextMonth.toISOString() });
    const st = await h.prisma.companyStatement.findMany({ where: { companyId } });
    expect(st).toHaveLength(1);
    expect(st[0]).toMatchObject({ month, orderCount: 1, chargedToea: 30000, closingBalanceToea: -10000 });

    const detail = await h.http().get(`/api/v1/admin/companies/${companyId}`).set(bearer(admin)).expect(200);
    expect(detail.body).toMatchObject({ owedToea: 10000, availableToea: 40000, employeeCount: 1 });
    expect(detail.body.statements).toHaveLength(1);
    expect(detail.body.payments[0]).toMatchObject({ amountToea: 20000 });
    await h.http().delete(`/api/v1/admin/companies/${companyId}/employees/${emp.userId}`).set(bearer(admin)).expect(204);
    expect((await place(emp.token)).status).toBe(422);
  });

  it('automatic receipt email after delivery, and the day report with delivery times and feedback', async () => {
    const { MockEmailProvider } = await import('../../src/notifications/email.provider');
    MockEmailProvider.outbox.splice(0);
    const admin = await adminLogin(h);
    const d = await approvedDriver(h);
    const c = await customer(h);
    await h.prisma.user.update({ where: { id: c.userId }, data: { email: 'mary@example.com', name: 'Mary Kila' } });
    const order = await placeCod(c.token);
    await placeCod(c.token); // a second order the same day that nobody takes
    await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(d.token)).set('Idempotency-Key', idem()).send().expect(200);
    await driveToDelivered(d.token, order.id);

    // Delivered: the automatic receipt is scheduled (waiting a few minutes for the signature), then sent once.
    expect(h.jobs.scheduled.some((j) => j.name === 'receipts.auto_send' && j.data.orderId === order.id)).toBe(true);
    await h.jobs.drain('receipts.auto_send', true);
    await h.jobs.run('receipts.auto_send', { orderId: order.id });
    const mails = MockEmailProvider.outbox.filter((m) => m.subject.includes(order.shortCode));
    expect(mails.map((m) => m.to)).toEqual(['mary@example.com']);
    const after = await h.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.receiptSentAt).not.toBeNull();
    expect(after.receiptEmail).toBe('mary@example.com');

    await h.http().post(`/api/v1/customer/orders/${order.id}/confirm`).set(bearer(c.token)).send().expect(200);
    await h.http().post(`/api/v1/customer/orders/${order.id}/rating`).set(bearer(c.token)).send({ stars: 4, comment: 'Fast, friendly driver' }).expect(201);

    // Day report for today (Port Moresby), filterable to a single date.
    const today = new Date(Date.now() + 10 * 3600_000).toISOString().slice(0, 10);
    const r = await h.http().get('/api/v1/admin/reports/day').query({ date: today }).set(bearer(admin)).expect(200);
    expect(r.body.summary).toMatchObject({ orders: 2, delivered: 1, litres: 5000, salesToea: 30000, averageStars: 4, ratings: 1 });
    const row = r.body.orders.find((o: { id: string }) => o.id === order.id);
    expect(row).toMatchObject({ shortCode: order.shortCode, status: 'COMPLETED', customer: { name: 'Mary Kila' }, rating: { stars: 4, comment: 'Fast, friendly driver' }, receiptEmail: 'mary@example.com' });
    expect(row.deliveredAt).toBeTruthy();
    const byDelivered = await h.http().get('/api/v1/admin/reports/day').query({ date: today, by: 'delivered' }).set(bearer(admin)).expect(200);
    expect(byDelivered.body.orders).toHaveLength(1);
    const other = await h.http().get('/api/v1/admin/reports/day').query({ date: '2020-01-01' }).set(bearer(admin)).expect(200);
    expect(other.body.orders).toHaveLength(0);
    const csv = await h.http().get('/api/v1/admin/reports/day.csv').query({ date: today }).set(bearer(admin)).expect(200);
    expect(csv.text).toContain('Fast, friendly driver');
    expect(csv.text.split('\r\n')[0]).toContain('delivered_at');
    expect((await h.http().get('/api/v1/admin/reports/day').query({ date: 'yesterday' }).set(bearer(admin))).status).not.toBe(200);

    // Turned off: nothing is sent automatically.
    await h.settings.set('receipt.auto_send', false, null);
    await h.prisma.order.update({ where: { id: order.id }, data: { receiptSentAt: null } });
    MockEmailProvider.outbox.splice(0);
    await h.jobs.run('receipts.auto_send', { orderId: order.id });
    expect(MockEmailProvider.outbox).toHaveLength(0);
  });

  it('manual booking: a driver books water for a customer by phone and gets the job straight away', async () => {
    const d = await approvedDriver(h);
    const other = await approvedDriver(h);
    const small = await h.prisma.package.create({ data: { name: 'Small (1,000 L)', volumeLitres: 1000, priceToea: 8000 } });
    const opts = await h.http().get('/api/v1/driver/booking-options').set(bearer(d.token)).expect(200);
    expect(opts.body.packages.map((p: { id: string }) => p.id)).toEqual([pkgId]); // only the truck's size
    expect(opts.body.truck.capacityLitres).toBe(5000);

    // An unknown number: no account yet.
    const lookup = await h.http().get('/api/v1/driver/customers/lookup').query({ phone: '7123 4567' }).set(bearer(d.token)).expect(200);
    expect(lookup.body).toMatchObject({ phone: '+67571234567', exists: false });
    const driverPhone = (await h.prisma.user.findFirstOrThrow({ where: { driver: { id: other.driverId } } })).phone;
    expect((await h.http().get('/api/v1/driver/customers/lookup').query({ phone: driverPhone }).set(bearer(d.token))).status).toBe(409);

    const book = (body: object, token = d.token) =>
      h.http().post('/api/v1/driver/bookings').set(bearer(token)).set('Idempotency-Key', idem())
        .send({ phone: '7123 4567', customerName: 'Peter Wari', packageId: pkgId, quantity: 1, paymentMethod: 'cod', location: { ...CUSTOMER_POINT, address: 'Section 12, Gerehu', notes: 'Green house' }, ...body });
    expect((await book({ packageId: small.id })).status).toBe(422); // wrong truck size

    const r = await book({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'ACCEPTED', paymentMethod: 'cod' });
    const order = await h.prisma.order.findUniqueOrThrow({ where: { id: r.body.id }, include: { customer: true, offers: true } });
    expect(order.driverId).toBe(d.driverId);
    expect(order.customer).toMatchObject({ phone: '+67571234567', name: 'Peter Wari', role: 'customer' });
    expect(order.offers).toHaveLength(0); // never sent to other drivers
    expect(await h.prisma.notification.count({ where: { userId: order.customerId, template: 'order.accepted' } })).toBeGreaterThan(0);

    // One job at a time.
    const busy = await book({});
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('driver_busy');

    // The customer can sign in later with that number and sees the order.
    const { otpLogin } = await import('./harness');
    const c = await otpLogin(h, '+67571234567', 'customer');
    expect(c.userId).toBe(order.customerId);
    const mine = await h.http().get(`/api/v1/customer/orders/${order.id}`).set(bearer(c.token)).expect(200);
    expect(mine.body.status).toBe('ACCEPTED');

    // The driver runs it like any other job.
    await driveToDelivered(d.token, order.id);
    const again = await h.http().get('/api/v1/driver/customers/lookup').query({ phone: '+67571234567' }).set(bearer(other.token)).expect(200);
    expect(again.body).toMatchObject({ exists: true, name: 'Peter Wari' });
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
