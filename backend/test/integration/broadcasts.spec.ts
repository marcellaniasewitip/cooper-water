import { Harness, startApp, resetDb, approvedDriver, customer, adminLogin } from './harness';
import { MockPushProvider } from '../../src/notifications/push.provider';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('admin push messages (integration)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetDb(h);
    MockPushProvider.sent.splice(0);
  });

  /** Deliver the queued push jobs (the test job runner only records them). */
  async function deliverQueued() {
    const jobs = h.jobs.scheduled.filter((j) => j.name === 'notifications.send');
    h.jobs.scheduled.splice(0);
    for (const j of jobs) await h.jobs.run('notifications.send', j.data);
  }

  it('sends to all drivers only, shows it in the driver Announcements, and keeps a history', async () => {
    const d1 = await approvedDriver(h, { online: false });
    const d2 = await approvedDriver(h, { online: false });
    const c = await customer(h);
    await h.prisma.user.update({ where: { id: d1.userId }, data: { fcmToken: 'tok-d1' } });
    const admin = await adminLogin(h);
    h.jobs.scheduled.splice(0);

    const count = await h.http().get('/api/v1/admin/broadcasts/count?audience=drivers').set(bearer(admin)).expect(200);
    expect(count.body.recipients).toBe(2);

    const sent = await h.http().post('/api/v1/admin/broadcasts').set(bearer(admin)).send({ audience: 'drivers', title: 'Depot closed', body: 'Gordons depot is closed today.' }).expect(201);
    expect(sent.body).toMatchObject({ audience: 'drivers', recipients: 2, title: 'Depot closed' });
    await deliverQueued();

    // Push went to the driver with a token; both drivers see it in the app.
    expect(MockPushProvider.sent).toHaveLength(1);
    expect(MockPushProvider.sent[0]).toMatchObject({ token: 'tok-d1', title: 'Depot closed', body: 'Gordons depot is closed today.' });
    for (const d of [d1, d2]) {
      const inbox = await h.http().get('/api/v1/driver/inbox').set(bearer(d.token)).expect(200);
      expect(inbox.body.items).toHaveLength(1);
      expect(inbox.body.items[0]).toMatchObject({ title: 'Depot closed', body: 'Gordons depot is closed today.' });
    }
    // Customers didn't get it.
    const cInbox = await h.http().get('/api/v1/customer/inbox').set(bearer(c.token)).expect(200);
    expect(cInbox.body.items.find((i: any) => i.template === 'broadcast')).toBeUndefined();

    const history = await h.http().get('/api/v1/admin/broadcasts').set(bearer(admin)).expect(200);
    expect(history.body.items).toHaveLength(1);
    expect(history.body.items[0]).toMatchObject({ audience: 'drivers', recipients: 2, pushed: 1 });
    expect(history.body.items[0].sentBy).toBeTruthy();
  });

  it('sends to one customer by phone and it appears in their Inbox', async () => {
    const c1 = await customer(h);
    const c2 = await customer(h);
    const admin = await adminLogin(h);
    const phone = (await h.prisma.user.findUniqueOrThrow({ where: { id: c1.userId } })).phone;

    const count = await h.http().get(`/api/v1/admin/broadcasts/count?audience=user&phone=${encodeURIComponent(phone)}`).set(bearer(admin)).expect(200);
    expect(count.body).toMatchObject({ recipients: 1, role: 'customer' });

    await h.http().post('/api/v1/admin/broadcasts').set(bearer(admin)).send({ audience: 'user', phone, title: 'Thank you', body: 'Your next delivery is on us.' }).expect(201);
    const inbox1 = await h.http().get('/api/v1/customer/inbox').set(bearer(c1.token)).expect(200);
    expect(inbox1.body.items[0]).toMatchObject({ title: 'Thank you', body: 'Your next delivery is on us.', template: 'broadcast' });
    const inbox2 = await h.http().get('/api/v1/customer/inbox').set(bearer(c2.token)).expect(200);
    expect(inbox2.body.items.find((i: any) => i.template === 'broadcast')).toBeUndefined();

    const missing = await h.http().post('/api/v1/admin/broadcasts').set(bearer(admin)).send({ audience: 'user', phone: '+67570000999', title: 'x', body: 'y' });
    expect(missing.status).toBe(404);
    const noPhone = await h.http().post('/api/v1/admin/broadcasts').set(bearer(admin)).send({ audience: 'user', title: 'x', body: 'y' });
    expect(noPhone.body.error.code).toBe('broadcast_phone_required');
  });

  it('"everyone" reaches drivers and customers but skips suspended accounts; the template cannot be edited', async () => {
    const d = await approvedDriver(h, { online: false });
    const c = await customer(h);
    const suspended = await customer(h);
    await h.prisma.user.update({ where: { id: suspended.userId }, data: { status: 'suspended' } });
    const admin = await adminLogin(h);

    const sent = await h.http().post('/api/v1/admin/broadcasts').set(bearer(admin)).send({ audience: 'all', title: 'Holiday hours', body: 'Open 8am to 2pm on Friday.' }).expect(201);
    expect(sent.body.recipients).toBe(2);
    const rows = await h.prisma.notification.findMany({ where: { template: 'broadcast' } });
    expect(rows.map((r) => r.userId).sort()).toEqual([d.userId, c.userId].sort());

    await h.http().put('/api/v1/admin/notification-templates/broadcast').set(bearer(admin)).send({ pushTitle: 'x' }).expect(404);
    const templates = await h.http().get('/api/v1/admin/notification-templates').set(bearer(admin)).expect(200);
    expect(templates.body.find((t: any) => t.key === 'broadcast')).toBeUndefined();
  });

  it('needs the notifications permission', async () => {
    const finance = await adminLogin(h, 'finance');
    const r = await h.http().post('/api/v1/admin/broadcasts').set(bearer(finance)).send({ audience: 'all', title: 'x', body: 'y' });
    expect(r.status).toBe(403);
  });
});
