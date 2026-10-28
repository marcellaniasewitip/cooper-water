import { logger } from '../common/logger';

export interface SmsSendResult {
  providerMessageId: string;
}

/** SMS gateway adapter (§9). Select with SMS_PROVIDER: mock (dev/tests) or clicksend. */
export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<SmsSendResult>;
}

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

/** A send that will never succeed on retry (bad number, account problem). Notifications stop retrying it. */
export class PermanentSmsError extends Error {
  readonly permanent = true;
}

/** Dev/test SMS: logs and keeps an in-memory outbox so tests and the simulator can read OTPs. */
export class MockSmsProvider implements SmsProvider {
  readonly name = 'mock';
  static readonly outbox: { to: string; body: string; at: Date }[] = [];
  /** Test hooks: make the next N sends fail (transiently / permanently). */
  static failNext = 0;
  static failNextPermanent = 0;

  async send(to: string, body: string): Promise<SmsSendResult> {
    if (MockSmsProvider.failNextPermanent > 0) {
      MockSmsProvider.failNextPermanent--;
      throw new PermanentSmsError('mock INVALID_RECIPIENT');
    }
    if (MockSmsProvider.failNext > 0) {
      MockSmsProvider.failNext--;
      throw new Error('mock sms failure');
    }
    MockSmsProvider.outbox.push({ to, body, at: new Date() });
    if (MockSmsProvider.outbox.length > 1000) MockSmsProvider.outbox.shift();
    logger.info({ to, body }, 'mock sms');
    return { providerMessageId: `mock-${Date.now()}` };
  }

  static lastTo(to: string): string | undefined {
    for (let i = MockSmsProvider.outbox.length - 1; i >= 0; i--) {
      if (MockSmsProvider.outbox[i].to === to) return MockSmsProvider.outbox[i].body;
    }
    return undefined;
  }
}

export interface ClickSendConfig {
  username: string;
  apiKey: string;
  /** Sender ID (alphanumeric, max 11 chars, or a dedicated number). Empty = ClickSend's shared number. */
  from?: string;
}

/** Per-message statuses ClickSend returns that retrying won't fix. */
const CLICKSEND_PERMANENT = new Set(['INVALID_RECIPIENT', 'COUNTRY_NOT_ENABLED', 'INSUFFICIENT_CREDIT', 'ACCOUNT_NOT_ACTIVATED', 'INVALID_SENDER_ID', 'ALREADY_EXISTS']);

/**
 * ClickSend SMS (https://developers.clicksend.com). POST /v3/sms/send with HTTP Basic auth
 * (account username + API key from the ClickSend dashboard → API Credentials).
 */
export class ClickSendSmsProvider implements SmsProvider {
  readonly name = 'clicksend';
  static readonly endpoint = 'https://rest.clicksend.com/v3/sms/send';

  constructor(
    private readonly cfg: ClickSendConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(to: string, body: string): Promise<SmsSendResult> {
    const message: Record<string, string> = { source: 'cooper-waters', to, body };
    if (this.cfg.from) message.from = this.cfg.from;
    const res = await this.fetchImpl(ClickSendSmsProvider.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.apiKey}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: [message] }),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) {
      throw new PermanentSmsError(`ClickSend rejected the credentials (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`ClickSend HTTP ${res.status}: ${json?.response_msg ?? 'request failed'}`);
    const msg = json?.data?.messages?.[0];
    if (msg?.status === 'SUCCESS' && msg.message_id) return { providerMessageId: String(msg.message_id) };
    const status = String(msg?.status ?? json?.response_code ?? 'UNKNOWN');
    const err = `ClickSend ${status}${json?.response_msg ? `: ${json.response_msg}` : ''}`;
    throw CLICKSEND_PERMANENT.has(status) ? new PermanentSmsError(err) : new Error(err);
  }
}

export function createSmsProvider(name: string, clicksend?: ClickSendConfig): SmsProvider {
  switch (name) {
    case 'mock':
      return new MockSmsProvider();
    case 'clicksend':
      if (!clicksend?.username || !clicksend.apiKey) {
        throw new Error('SMS_PROVIDER=clicksend requires CLICKSEND_USERNAME and CLICKSEND_API_KEY');
      }
      return new ClickSendSmsProvider(clicksend);
    default:
      throw new Error(`Unknown SMS_PROVIDER ${name} (use mock or clicksend)`);
  }
}

/** GSM 03.38 basic character set + extension table. SMS templates must stay within it (§9). */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.includes(ch) && !GSM7_EXT.includes(ch)) return false;
  }
  return true;
}

/** Length in GSM-7 septets (extension chars count double). */
export function gsm7Length(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM7_EXT.includes(ch) ? 2 : 1;
  return n;
}
