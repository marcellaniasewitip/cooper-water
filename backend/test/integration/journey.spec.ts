import { Harness, startApp, resetDb, approvedDriver, customer, idem, adminLogin, walletBalance, CUSTOMER_POINT, DEPOT } from './harness';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/**
 * The whole job, through the same endpoints the apps and the admin dashboard call:
 * customer orders → admin sees it → driver gets the offer (live) → accepts → chat both ways →
 * depot → loaded → arrived → delivered → customer confirms and rates → everything settled.
 */
describe('full delivery journey (customer app → admin → driver app)', () => {
  let h: Harness;
  let pkgId: string;
  let toUser: jest.SpyInstance;
  let toAdmins: jest.SpyInstance;

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    const { pkg } = await resetDb(h);
    pkgId = pkg.id;
    const rt = h.app.get(RealtimeGateway);
    toUser = jest.spyOn(rt, 'toUser');
    toAdmins = jest.spyOn(rt, 'toAdmins');
  });
  afterEach(() => jest.restoreAllMocks());

  const eventsTo = (userId: string, event: string) => toUser.mock.calls.filter(([u, e]) => u === userId && e === event).map(([, , p]) => p);
  const adminEvents = (event: string) => toAdmins.mock.calls.filter(([e]) => e === event).map(([, p]) => p);

  it('customer request is seen by admin and the driver, accepted, chatted, delivered and completed', async () => {
    const admin = await adminLogin(h);
    const driver = await approvedDriver(h, { balanceToea: 20000 }); // online at the depot
    const cust = await customer(h);

    // 1. Customer app: catalogue, quote, saved place, order (cash on delivery).
    const pkgs = await h.http().get('/api/v1/customer/packages').set(bearer(cust.token));
    expect(pkgs.status).toBe(200);
    expect(pkgs.body.map((p: { id: string }) => p.id)).toContain(pkgId);
    const quote = await h.http().post('/api/v1/customer/quote').set(bearer(cust.token)).send({ packageId: pkgId, quantity: 1 });
    expect(quote.status).toBe(200);
    expect(quote.body.priceToea).toBe(30000);
    const place = await h.http().post('/api/v1/customer/locations').set(bearer(cust.token))
      .send({ label: 'Home', addressText: 'Lot 5, Boroko', ...CUSTOMER_POINT, landmarkNotes: 'Blue gate' });
    expect(place.status).toBe(201);

    const created = await h.http().post('/api/v1/customer/orders').set(bearer(cust.token)).set('Idempotency-Key', idem())
      .send({ packageId: pkgId, quantity: 1, paymentMethod: 'cod', locationId: place.body.id });
    expect(created.status).toBe(201);
    const order = created.body.order;
    expect(order.status).toBe('SEARCHING');

    // 2. Admin dashboard: the new order is in the Orders list and its detail page.
    const list = await h.http().get('/api/v1/admin/orders').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.items.map((o: { id: string }) => o.id)).toContain(order.id);
    const detail = await h.http().get(`/api/v1/admin/orders/${order.id}`).set(bearer(admin));
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('SEARCHING');
    // ...and the fleet map shows the driver online and free.
    const fleet = await h.http().get('/api/v1/admin/fleet').set(bearer(admin));
    expect(fleet.status).toBe(200);
    expect(JSON.stringify(fleet.body)).toContain(driver.driverId);

    // 3. Driver app: the offer arrives live (rings) and is in the offers list.
    const liveOffers = eventsTo(driver.userId, 'order.offer') as { offer: { orderId: string } }[];
    expect(liveOffers.map((p) => p.offer.orderId)).toContain(order.id);
    const offers = await h.http().get('/api/v1/driver/offers').set(bearer(driver.token));
    expect(offers.status).toBe(200);
    expect(JSON.stringify(offers.body)).toContain(order.id);

    // 4. Driver accepts; customer and admin are told live.
    const acc = await h.http().post(`/api/v1/driver/orders/${order.id}/accept`).set(bearer(driver.token)).set('Idempotency-Key', idem()).send();
    expect(acc.status).toBe(200);
    expect((eventsTo(cust.userId, 'order.updated') as { order: { status: string } }[]).map((p) => p.order.status)).toContain('ACCEPTED');
    expect((adminEvents('order.updated') as { order: { id: string; status: string } }[]).some((p) => p.order.id === order.id && p.order.status === 'ACCEPTED')).toBe(true);
    const active = await h.http().get('/api/v1/driver/orders/active').set(bearer(driver.token));
    expect(active.status).toBe(200);
    expect(JSON.stringify(active.body)).toContain(order.id);
    const seen = await h.http().get(`/api/v1/customer/orders/${order.id}`).set(bearer(cust.token));
    expect(seen.body.status).toBe('ACCEPTED');
    expect(seen.body.driver?.name).toBeTruthy();

    // 5. Chat both ways, delivered live to the other side; admin can read it.
    const d1 = await h.http().post(`/api/v1/driver/orders/${order.id}/messages`).set(bearer(driver.token)).send({ body: 'On my way, 20 minutes.' });
    expect(d1.status).toBe(201);
    expect(eventsTo(cust.userId, 'chat.message').length).toBe(1);
    // ...and a phone notification is queued for it (banner when the app is in the background/closed).
    const chatPush = await h.prisma.notification.findFirst({ where: { userId: cust.userId, template: 'chat.message', channel: 'push' } });
    expect(chatPush?.payload).toMatchObject({ orderId: order.id, messageId: d1.body.id, preview: 'On my way, 20 minutes.' });
    const c1 = await h.http().post(`/api/v1/customer/orders/${order.id}/messages`).set(bearer(cust.token)).send({ body: 'Thanks, the gate is open.' });
    expect(c1.status).toBe(201);
    expect(eventsTo(driver.userId, 'chat.message').length).toBe(1);
    const thread = await h.http().get(`/api/v1/customer/orders/${order.id}/messages`).set(bearer(cust.token));
    expect(JSON.stringify(thread.body)).toContain('On my way, 20 minutes.');
    expect(JSON.stringify(thread.body)).toContain('Thanks, the gate is open.');
    const adminThread = await h.http().get(`/api/v1/admin/orders/${order.id}/messages`).set(bearer(admin));
    expect(adminThread.status).toBe(200);
    expect(JSON.stringify(adminThread.body)).toContain('Thanks, the gate is open.');

    // 6. Driver: depot → loaded → at the customer → delivered.
    for (const [step, body] of [['arrive-depot', DEPOT], ['loaded', DEPOT], ['arrived', CUSTOMER_POINT], ['delivered', {}]] as [string, object][]) {
      const r = await h.http().post(`/api/v1/driver/orders/${order.id}/${step}`).set(bearer(driver.token)).send(body);
      expect({ step, status: r.status }).toEqual({ step, status: 200 });
    }
    const customerStatuses = (eventsTo(cust.userId, 'order.updated') as { order: { status: string } }[]).map((p) => p.order.status);
    expect(customerStatuses).toEqual(expect.arrayContaining(['ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED', 'DELIVERED']));

    // 7. Customer confirms and rates; money settles (commission off the driver's wallet).
    const conf = await h.http().post(`/api/v1/customer/orders/${order.id}/confirm`).set(bearer(cust.token)).send();
    expect(conf.status).toBe(200);
    expect(conf.body.status).toBe('COMPLETED');
    const rate = await h.http().post(`/api/v1/customer/orders/${order.id}/rating`).set(bearer(cust.token)).send({ stars: 5, comment: 'Fast and friendly' });
    expect([200, 201]).toContain(rate.status);
    expect(await walletBalance(h, 'driver', driver.driverId)).toBe(20000 - 3000);

    const finalAdmin = await h.http().get(`/api/v1/admin/orders/${order.id}`).set(bearer(admin));
    expect(finalAdmin.body.status).toBe('COMPLETED');
    const history = await h.http().get('/api/v1/driver/orders').set(bearer(driver.token));
    expect(JSON.stringify(history.body)).toContain(order.id);
  });
});
