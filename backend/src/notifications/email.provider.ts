import { createTransport, type Transporter } from 'nodemailer';
import { loadEnv } from '../config/env';
import { logger } from '../common/logger';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Inline images referenced from the HTML as <img src="cid:...">. */
  inline?: { cid: string; filename: string; contentType: string; content: Buffer }[];
}

export interface EmailProvider {
  readonly configured: boolean;
  send(msg: EmailMessage): Promise<{ id: string }>;
}

/** SMTP (Amazon SES SMTP, Gmail/Workspace, Microsoft 365, any mail server). */
export class SmtpEmailProvider implements EmailProvider {
  readonly configured = true;
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = createTransport(smtpUrl);
  }

  async send(msg: EmailMessage): Promise<{ id: string }> {
    const info = await this.transport.sendMail({
      from: this.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: (msg.inline ?? []).map((a) => ({ cid: a.cid, filename: a.filename, contentType: a.contentType, content: a.content })),
    });
    return { id: String(info.messageId ?? '') };
  }
}

/** No mail server configured (and tests): keeps the messages so they can be checked, and logs them. */
export class MockEmailProvider implements EmailProvider {
  static readonly outbox: EmailMessage[] = [];
  readonly configured = false;

  async send(msg: EmailMessage): Promise<{ id: string }> {
    MockEmailProvider.outbox.push(msg);
    if (MockEmailProvider.outbox.length > 50) MockEmailProvider.outbox.shift();
    logger.info({ to: msg.to, subject: msg.subject }, 'Email not sent: SMTP_URL / EMAIL_FROM not configured');
    return { id: `mock-${MockEmailProvider.outbox.length}` };
  }
}

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export function createEmailProvider(): EmailProvider {
  const env = loadEnv();
  if (env.smtpUrl && env.emailFrom && env.nodeEnv !== 'test') return new SmtpEmailProvider(env.smtpUrl, env.emailFrom);
  return new MockEmailProvider();
}
