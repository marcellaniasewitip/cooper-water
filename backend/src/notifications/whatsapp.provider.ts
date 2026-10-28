import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { logger } from '../common/logger';

/**
 * WhatsApp delivery for sign-in codes. Meta's Cloud API sends them as an "authentication" template
 * (the approved message shows the code plus a one-tap "Copy code" button). Delivery results arrive
 * later on the status webhook; a number that isn't on WhatsApp is usually reported there as failed.
 */
export interface WhatsAppProvider {
  readonly name: string;
  /** Resolves with Meta's message id once the API accepted the message. Rejects if it was refused. */
  sendOtp(toE164: string, code: string): Promise<{ messageId: string }>;
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean;
  /** Delivery status updates contained in a webhook body. */
  parseStatuses(rawBody: Buffer): WhatsAppStatus[];
}

export interface WhatsAppStatus {
  messageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed' | string;
  errorCode?: number;
  errorTitle?: string;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

export interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
  templateName: string;
  templateLanguage: string;
  apiVersion: string;
}

/** Meta WhatsApp Cloud API (graph.facebook.com). */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'meta';

  constructor(
    private readonly cfg: MetaWhatsAppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async sendOtp(toE164: string, code: string): Promise<{ messageId: string }> {
    const url = `https://graph.facebook.com/${this.cfg.apiVersion}/${this.cfg.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: this.cfg.templateName,
        language: { code: this.cfg.templateLanguage },
        // Authentication templates take the code twice: in the body and in the copy-code button.
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    };
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => ({}));
    const messageId = json?.messages?.[0]?.id;
    if (!res.ok || !messageId) {
      const e = json?.error ?? {};
      throw new WhatsAppSendError(e.code, `${e.message ?? `HTTP ${res.status}`}${e.error_data?.details ? `: ${e.error_data.details}` : ''}`);
    }
    return { messageId };
  }

  /** Meta signs webhooks with HMAC-SHA256 of the raw body using the app secret (X-Hub-Signature-256). */
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean {
    return verifyHubSignature(this.cfg.appSecret, headers['x-hub-signature-256'], rawBody);
  }

  parseStatuses(rawBody: Buffer): WhatsAppStatus[] {
    return parseMetaStatuses(rawBody);
  }
}

/**
 * Dev/test WhatsApp: logs codes instead of sending. Numbers ending in 8888 are refused outright by the
 * "API"; any message can be marked undeliverable with a signed test webhook (buildStatusWebhook).
 */
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock';
  static readonly sent: { to: string; code: string; messageId: string }[] = [];

  constructor(private readonly appSecret: string) {}

  async sendOtp(toE164: string, code: string): Promise<{ messageId: string }> {
    if (toE164.endsWith('8888')) throw new WhatsAppSendError(131030, 'Recipient phone number not in allowed list (mock)');
    const messageId = `wamid.mock-${randomUUID()}`;
    MockWhatsAppProvider.sent.push({ to: toE164, code, messageId });
    if (MockWhatsAppProvider.sent.length > 1000) MockWhatsAppProvider.sent.shift();
    logger.info({ to: toE164, code, messageId }, 'mock whatsapp otp');
    return { messageId };
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): boolean {
    return verifyHubSignature(this.appSecret, headers['x-hub-signature-256'], rawBody);
  }

  parseStatuses(rawBody: Buffer): WhatsAppStatus[] {
    return parseMetaStatuses(rawBody);
  }

  /** A signed status webhook exactly as Meta sends it (tests and local experiments). */
  buildStatusWebhook(messageId: string, status: WhatsAppStatus['status'], errorCode?: number) {
    const rawBody = Buffer.from(
      JSON.stringify({
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'mock-waba',
            changes: [
              {
                field: 'messages',
                value: {
                  messaging_product: 'whatsapp',
                  statuses: [
                    {
                      id: messageId,
                      status,
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      ...(errorCode ? { errors: [{ code: errorCode, title: 'Message undeliverable' }] } : {}),
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const headers = { 'x-hub-signature-256': `sha256=${createHmac('sha256', this.appSecret).update(rawBody).digest('hex')}`, 'content-type': 'application/json' };
    return { rawBody, headers };
  }

  static lastTo(toE164: string) {
    for (let i = MockWhatsAppProvider.sent.length - 1; i >= 0; i--) {
      if (MockWhatsAppProvider.sent[i].to === toE164) return MockWhatsAppProvider.sent[i];
    }
    return undefined;
  }
}

export class WhatsAppSendError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
  }
}

function verifyHubSignature(secret: string, header: string | undefined, rawBody: Buffer): boolean {
  if (!secret || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function parseMetaStatuses(rawBody: Buffer): WhatsAppStatus[] {
  const body = JSON.parse(rawBody.toString('utf8'));
  const out: WhatsAppStatus[] = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      for (const s of change?.value?.statuses ?? []) {
        if (typeof s?.id !== 'string' || typeof s?.status !== 'string') continue;
        out.push({ messageId: s.id, status: s.status, errorCode: s.errors?.[0]?.code, errorTitle: s.errors?.[0]?.title });
      }
    }
  }
  return out;
}

export function createWhatsAppProvider(name: string, env: { meta?: MetaWhatsAppConfig; mockSecret: string }): WhatsAppProvider | null {
  if (name === 'none' || !name) return null;
  if (name === 'mock') return new MockWhatsAppProvider(env.mockSecret);
  if (name === 'meta') {
    const m = env.meta;
    if (!m?.accessToken || !m.phoneNumberId || !m.appSecret) {
      throw new Error('WHATSAPP_PROVIDER=meta requires WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET');
    }
    return new MetaWhatsAppProvider(m);
  }
  throw new Error(`Unknown WHATSAPP_PROVIDER ${name}`);
}
