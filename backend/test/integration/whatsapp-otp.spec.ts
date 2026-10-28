import { Harness, startApp, resetDb, nextPhone } from './harness';
import { MockSmsProvider } from '../../src/notifications/sms.provider';
import { MockWhatsAppProvider, WHATSAPP_PROVIDER } from '../../src/notifications/whatsapp.provider';
import { SweeperService } from '../../src/jobs/sweeper.service';

describe('sign-in codes over WhatsApp with SMS fallback (integration)', () => {
  let h: Harness;
  let wa: MockWhatsAppProvider;

  beforeAll(async () => {
    h = await startApp();
    wa = h.app.get(WHATSAPP_PROVIDER);
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetDb(h);
    await h.settings.set('otp.primary_channel', 'whatsapp', null);
    MockWhatsAppProvider.sent.splice(0);
  });

  const smsTo = (e164: string) => MockSmsProvider.outbox.filter((m) => m.to === e164);
  const request = (phone: string, body: object = {}) => h.http().post('/api/v1/auth/otp/request').send({ phone, ...body });
  const postStatus = (messageId: string, status: string, errorCode?: number) => {
    const { rawBody, headers } = wa.buildStatusWebhook(messageId, status, errorCode);
    return h.http().post('/api/v1/webhooks/whatsapp').set(headers).send(rawBody.toString('utf8'));
  };

  it('sends the code by WhatsApp first and signs in with it', async () => {
    const phone = nextPhone();
    const r = await request(phone).expect(200);
    expect(r.body).toMatchObject({ channel: 'whatsapp', ttlSec: 300 });
    const msg = MockWhatsAppProvider.lastTo(r.body.phone)!;
    expect(msg.code).toMatch(/^\d{6}$/);
    expect(smsTo(r.body.phone)).toHaveLength(0);
    const v = await h.http().post('/api/v1/auth/otp/verify').send({ phone, code: msg.code, app: 'customer' });
    expect(v.status).toBe(200);
    expect(v.body.accessToken).toBeTruthy();
  });

  it('falls back to SMS immediately when WhatsApp refuses the number', async () => {
    const phone = '7110' + '8888';
    const r = await request(phone).expect(200);
    expect(r.body.channel).toBe('sms');
    expect(smsTo(r.body.phone)).toHaveLength(1);
    const wan = await h.prisma.notification.findFirstOrThrow({ where: { channel: 'whatsapp' } });
    expect(wan).toMatchObject({ status: 'failed', deliveryStatus: 'failed' });
  });

  it('webhook "failed" (not on WhatsApp) re-sends the SAME code by SMS, once', async () => {
    const phone = nextPhone();
    const r = await request(phone).expect(200);
    const msg = MockWhatsAppProvider.lastTo(r.body.phone)!;
    await postStatus(msg.messageId, 'failed', 131026).expect(200);
    await postStatus(msg.messageId, 'failed', 131026).expect(200); // duplicate delivery
    await h.jobs.drain('notifications.otp_fallback', true);
    const sms = smsTo(r.body.phone);
    expect(sms).toHaveLength(1);
    expect(sms[0].body).toContain(msg.code);
    // The timer firing later doesn't send a second SMS.
    await h.jobs.drain('notifications.otp_fallback', true);
    expect(smsTo(r.body.phone)).toHaveLength(1);
    await h.http().post('/api/v1/auth/otp/verify').send({ phone, code: msg.code, app: 'customer' }).expect(200);
  });

  it('timer: SMS goes out if WhatsApp never confirms delivery, but not once it has', async () => {
    const a = nextPhone();
    const ra = await request(a).expect(200);
    await h.jobs.drain('notifications.otp_fallback', true); // no status ever arrived
    expect(smsTo(ra.body.phone)).toHaveLength(1);

    const b = nextPhone();
    const rb = await request(b).expect(200);
    const mb = MockWhatsAppProvider.lastTo(rb.body.phone)!;
    await postStatus(mb.messageId, 'sent').expect(200);
    await postStatus(mb.messageId, 'delivered').expect(200);
    await postStatus(mb.messageId, 'sent').expect(200); // late, out-of-order status doesn't downgrade
    await h.jobs.drain('notifications.otp_fallback', true);
    expect(smsTo(rb.body.phone)).toHaveLength(0);
    const n = await h.prisma.notification.findUniqueOrThrow({ where: { providerMessageId: mb.messageId } });
    expect(n.deliveryStatus).toBe('delivered');
  });

  it('no fallback once the code was used', async () => {
    const phone = nextPhone();
    const r = await request(phone).expect(200);
    const msg = MockWhatsAppProvider.lastTo(r.body.phone)!;
    await h.http().post('/api/v1/auth/otp/verify').send({ phone, code: msg.code, app: 'driver' }).expect(200);
    await h.jobs.drain('notifications.otp_fallback', true);
    expect(smsTo(r.body.phone)).toHaveLength(0);
  });

  it('"Send by SMS instead" re-sends the current code once', async () => {
    const phone = nextPhone();
    const r = await request(phone).expect(200);
    const msg = MockWhatsAppProvider.lastTo(r.body.phone)!;
    const s1 = await h.http().post('/api/v1/auth/otp/resend-sms').send({ phone }).expect(200);
    const s2 = await h.http().post('/api/v1/auth/otp/resend-sms').send({ phone }).expect(200);
    expect(s1.body.channel).toBe('sms');
    expect(s2.body.channel).toBe('sms');
    const sms = smsTo(r.body.phone);
    expect(sms).toHaveLength(1);
    expect(sms[0].body).toContain(msg.code);
  });

  it('resend-sms without an active code is rejected', async () => {
    const r = await h.http().post('/api/v1/auth/otp/resend-sms').send({ phone: nextPhone() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('otp_expired');
  });

  it('client can ask for SMS directly; admin can make SMS the primary channel', async () => {
    const r1 = await request(nextPhone(), { channel: 'sms' }).expect(200);
    expect(r1.body.channel).toBe('sms');
    await h.settings.set('otp.primary_channel', 'sms', null);
    const r2 = await request(nextPhone()).expect(200);
    expect(r2.body.channel).toBe('sms');
    expect(MockWhatsAppProvider.sent).toHaveLength(0);
  });

  it('webhook: verification handshake and signature check', async () => {
    const ok = await h.http().get('/api/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'dev-whatsapp-verify-token', 'hub.challenge': '12345' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('12345');
    const bad = await h.http().get('/api/v1/webhooks/whatsapp').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
    const { rawBody } = wa.buildStatusWebhook('wamid.x', 'failed', 131026);
    const forged = await h.http().post('/api/v1/webhooks/whatsapp').set({ 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }).send(rawBody.toString('utf8'));
    expect(forged.status).toBe(401);
  });

  it('codes are removed from stored notifications after 30 minutes', async () => {
    const r = await request(nextPhone()).expect(200);
    await h.prisma.notification.updateMany({ data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    const counts = await h.app.get(SweeperService).sweep();
    expect(counts.otp_codes_redacted).toBeGreaterThanOrEqual(1);
    const n = await h.prisma.notification.findFirstOrThrow({ where: { phone: r.body.phone, template: 'auth.otp' } });
    expect((n.payload as any).code).toBeUndefined();
  });
});
