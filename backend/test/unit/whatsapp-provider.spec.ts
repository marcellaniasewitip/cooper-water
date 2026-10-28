import { createHmac } from 'crypto';
import { MetaWhatsAppProvider, WhatsAppSendError, createWhatsAppProvider } from '../../src/notifications/whatsapp.provider';

const cfg = { accessToken: 'tok', phoneNumberId: '1234567890', appSecret: 'secret', templateName: 'cooper_waters_otp', templateLanguage: 'en', apiVersion: 'v21.0' };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body } as any;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('MetaWhatsAppProvider', () => {
  it('sends an authentication template with the code in the body and copy-code button', async () => {
    const f = fakeFetch(200, { messages: [{ id: 'wamid.ABC' }] });
    const p = new MetaWhatsAppProvider(cfg, f.fn);
    await expect(p.sendOtp('+67571234567', '042917')).resolves.toEqual({ messageId: 'wamid.ABC' });
    expect(f.calls[0].url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '67571234567',
      type: 'template',
      template: {
        name: 'cooper_waters_otp',
        language: { code: 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '042917' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '042917' }] },
        ],
      },
    });
  });

  it('surfaces Meta API errors', async () => {
    const f = fakeFetch(400, { error: { code: 131030, message: 'Recipient phone number not in allowed list' } });
    const p = new MetaWhatsAppProvider(cfg, f.fn);
    await expect(p.sendOtp('+67571234567', '1')).rejects.toMatchObject({ code: 131030 });
    await expect(p.sendOtp('+67571234567', '1')).rejects.toBeInstanceOf(WhatsAppSendError);
  });

  it('verifies X-Hub-Signature-256 and parses delivery statuses', () => {
    const p = new MetaWhatsAppProvider(cfg);
    const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] } }] }] }));
    const sig = 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex');
    expect(p.verifyWebhook({ 'x-hub-signature-256': sig }, raw)).toBe(true);
    expect(p.verifyWebhook({ 'x-hub-signature-256': 'sha256=bad' }, raw)).toBe(false);
    expect(p.verifyWebhook({}, raw)).toBe(false);
    expect(p.parseStatuses(raw)).toEqual([{ messageId: 'wamid.1', status: 'failed', errorCode: 131026, errorTitle: 'Message undeliverable' }]);
  });

  it('factory: none disables WhatsApp; meta requires credentials', () => {
    expect(createWhatsAppProvider('none', { mockSecret: 'x' })).toBeNull();
    expect(() => createWhatsAppProvider('meta', { meta: { ...cfg, accessToken: '' }, mockSecret: 'x' })).toThrow(/WHATSAPP_ACCESS_TOKEN/);
    expect(createWhatsAppProvider('meta', { meta: cfg, mockSecret: 'x' })?.name).toBe('meta');
  });
});
