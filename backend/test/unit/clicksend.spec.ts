import { ClickSendSmsProvider, PermanentSmsError, createSmsProvider } from '../../src/notifications/sms.provider';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: any }[] = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body } as any;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const ok = { http_code: 200, response_code: 'SUCCESS', response_msg: 'Messages queued for delivery.', data: { messages: [{ status: 'SUCCESS', message_id: 'B2D1A8E0-1234' }] } };

describe('ClickSendSmsProvider', () => {
  it('posts the message with Basic auth and returns the message id', async () => {
    const f = fakeFetch(200, ok);
    const p = new ClickSendSmsProvider({ username: 'ops@cooperwaters.com.pg', apiKey: 'KEY-123', from: 'CooperWater' }, f.fn);
    await expect(p.send('+67571234567', 'Cooper Waters code: 123456')).resolves.toEqual({ providerMessageId: 'B2D1A8E0-1234' });
    expect(f.calls[0].url).toBe('https://rest.clicksend.com/v3/sms/send');
    expect(f.calls[0].init.method).toBe('POST');
    expect(f.calls[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('ops@cooperwaters.com.pg:KEY-123').toString('base64')}`);
    expect(JSON.parse(f.calls[0].init.body)).toEqual({
      messages: [{ source: 'cooper-waters', to: '+67571234567', body: 'Cooper Waters code: 123456', from: 'CooperWater' }],
    });
  });

  it('omits the sender when none is configured (ClickSend shared number)', async () => {
    const f = fakeFetch(200, ok);
    await new ClickSendSmsProvider({ username: 'u', apiKey: 'k' }, f.fn).send('+67571234567', 'hi');
    expect(JSON.parse(f.calls[0].init.body).messages[0].from).toBeUndefined();
  });

  it('treats a bad number or empty credit as permanent', async () => {
    const f = fakeFetch(200, { ...ok, data: { messages: [{ status: 'INVALID_RECIPIENT' }] } });
    const p = new ClickSendSmsProvider({ username: 'u', apiKey: 'k' }, f.fn);
    await expect(p.send('+675123', 'x')).rejects.toBeInstanceOf(PermanentSmsError);
    const g = fakeFetch(200, { ...ok, data: { messages: [{ status: 'INSUFFICIENT_CREDIT' }] } });
    await expect(new ClickSendSmsProvider({ username: 'u', apiKey: 'k' }, g.fn).send('+67571234567', 'x')).rejects.toBeInstanceOf(PermanentSmsError);
  });

  it('labels a bad number as a recipient problem and other refusals as account problems', async () => {
    const bad = fakeFetch(200, { ...ok, data: { messages: [{ status: 'INVALID_RECIPIENT' }] } });
    expect(await new ClickSendSmsProvider({ username: 'u', apiKey: 'k' }, bad.fn).send('+675123', 'x').catch((e) => e.kind)).toBe('recipient');
    const credit = fakeFetch(200, { ...ok, data: { messages: [{ status: 'COUNTRY_NOT_ENABLED' }] } });
    expect(await new ClickSendSmsProvider({ username: 'u', apiKey: 'k' }, credit.fn).send('+67571234567', 'x').catch((e) => e.kind)).toBe('account');
    const auth = fakeFetch(401, { response_code: 'UNAUTHORIZED' });
    expect(await new ClickSendSmsProvider({ username: 'u', apiKey: 'bad' }, auth.fn).send('+67571234567', 'x').catch((e) => e.kind)).toBe('account');
  });

  it('retries without the sender ID when ClickSend refuses it', async () => {
    const calls: any[] = [];
    const fn = (async (_url: string, init: any) => {
      const msg = JSON.parse(init.body).messages[0];
      calls.push(msg);
      const body = msg.from ? { ...ok, data: { messages: [{ status: 'INVALID_SENDER_ID' }] } } : ok;
      return { ok: true, status: 200, json: async () => body } as any;
    }) as unknown as typeof fetch;
    await expect(new ClickSendSmsProvider({ username: 'u', apiKey: 'k', from: 'CooperWater' }, fn).send('+67571234567', 'hi')).resolves.toEqual({ providerMessageId: 'B2D1A8E0-1234' });
    expect(calls.map((m) => m.from)).toEqual(['CooperWater', undefined]);
  });

  it('treats bad credentials as permanent and server errors as retryable', async () => {
    const auth = fakeFetch(401, { response_code: 'UNAUTHORIZED' });
    await expect(new ClickSendSmsProvider({ username: 'u', apiKey: 'bad' }, auth.fn).send('+67571234567', 'x')).rejects.toBeInstanceOf(PermanentSmsError);
    const down = fakeFetch(503, {});
    const err = await new ClickSendSmsProvider({ username: 'u', apiKey: 'k' }, down.fn).send('+67571234567', 'x').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(PermanentSmsError);
  });

  it('factory requires credentials for clicksend and rejects unknown providers', () => {
    expect(() => createSmsProvider('clicksend', { username: '', apiKey: '' })).toThrow(/CLICKSEND_USERNAME/);
    expect(createSmsProvider('clicksend', { username: 'u', apiKey: 'k' }).name).toBe('clicksend');
    expect(createSmsProvider('mock').name).toBe('mock');
    expect(() => createSmsProvider('gateway')).toThrow(/Unknown SMS_PROVIDER/);
  });
});
