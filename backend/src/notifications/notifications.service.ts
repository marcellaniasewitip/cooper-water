import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { logger } from '../common/logger';
import { PUSH_PROVIDER, PushProvider } from './push.provider';
import { SMS_PROVIDER, SmsProvider, gsm7Length, isGsm7 } from './sms.provider';
import { DEFAULT_TEMPLATES, TemplateDef, render } from './templates';
import { Errors } from '../common/errors';

const MAX_ATTEMPTS = 5;

/**
 * Push first; SMS for OTP, critical events, or when push isn't delivered (§9).
 * Every send is a Notification row processed by a queued job with exponential backoff.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
  ) {}

  onModuleInit(): void {
    this.jobs.register('notifications.send', (d) => this.deliver(d.notificationId));
  }

  /** Notify a user by template. Never throws for delivery problems (business flows must not fail on them). */
  async notify(userId: string, templateKey: string, vars: Record<string, unknown> = {}): Promise<void> {
    try {
      const [user, tpl] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, phone: true, fcmToken: true } }),
        this.template(templateKey),
      ]);
      if (!user || !tpl) return;
      const pushable = !!(tpl.pushTitle && tpl.pushBody);
      if (pushable) {
        await this.queue({ userId, phone: user.phone, channel: 'push', template: templateKey, payload: vars });
      }
      // SMS if critical, or there's no push template, or the user can't receive push at all.
      if (tpl.smsBody && (tpl.critical || !pushable || !user.fcmToken)) {
        await this.queue({ userId, phone: user.phone, channel: 'sms', template: templateKey, payload: vars });
      }
    } catch (err) {
      logger.error({ err, userId, templateKey }, 'notify failed');
    }
  }

  /** OTP goes straight out by SMS (time-critical); on failure it falls back to the retry queue. */
  async sendOtp(phone: string, code: string, ttlSec: number): Promise<void> {
    const n = await this.prisma.notification.create({
      data: { phone, channel: 'sms', template: 'auth.otp', payload: { code, minutes: Math.ceil(ttlSec / 60) } },
    });
    try {
      await this.deliver(n.id);
    } catch {
      await this.jobs.enqueue('notifications', 'notifications.send', { notificationId: n.id }, { jobId: `notif-${n.id}` });
    }
  }

  /** Job handler. Throws to trigger BullMQ backoff while attempts remain. */
  async deliver(notificationId: string): Promise<void> {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId }, include: { user: true } });
    if (!n || n.status === 'sent' || n.status === 'skipped') return;
    const tpl = await this.template(n.template);
    if (!tpl) {
      await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'skipped', lastError: 'no template' } });
      return;
    }
    const vars = (n.payload ?? {}) as Record<string, unknown>;
    try {
      if (n.channel === 'push') {
        const token = n.user?.fcmToken;
        if (!token) {
          await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'skipped', lastError: 'no push token' } });
          return;
        }
        await this.push.send({
          token,
          title: render(tpl.pushTitle ?? '', vars),
          body: render(tpl.pushBody ?? '', vars),
          data: { template: n.template, ...stringify(vars) },
        });
      } else {
        const to = n.phone ?? n.user?.phone;
        if (!to || !tpl.smsBody) {
          await this.prisma.notification.update({ where: { id: n.id }, data: { status: 'skipped', lastError: 'no phone/sms body' } });
          return;
        }
        await this.sms.send(to, truncateSms(render(tpl.smsBody, vars)));
      }
      await this.prisma.notification.update({
        where: { id: n.id },
        data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 } },
      });
    } catch (err: any) {
      const attempts = n.attempts + 1;
      const giveUp = attempts >= MAX_ATTEMPTS || (n.channel === 'push' && isPermanentPushError(err));
      await this.prisma.notification.update({
        where: { id: n.id },
        data: { attempts, lastError: String(err?.message ?? err).slice(0, 500), status: giveUp ? 'failed' : 'queued' },
      });
      if (!giveUp) throw err; // BullMQ retries with exponential backoff
      // Push not delivered → fall back to SMS once, if the template has an SMS body (§9).
      if (n.channel === 'push' && tpl.smsBody && n.userId) {
        await this.queue({ userId: n.userId, phone: n.phone, channel: 'sms', template: n.template, payload: vars, dedupe: true });
      }
    }
  }

  async template(key: string): Promise<TemplateDef | null> {
    const row = await this.prisma.notificationTemplate.findUnique({ where: { key } });
    if (row) {
      return {
        key: row.key,
        pushTitle: row.pushTitle ?? undefined,
        pushBody: row.pushBody ?? undefined,
        smsBody: row.smsBody ?? undefined,
        critical: row.critical,
      };
    }
    return DEFAULT_TEMPLATES.find((t) => t.key === key) ?? null;
  }

  async listTemplates(): Promise<TemplateDef[]> {
    const rows = await this.prisma.notificationTemplate.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return DEFAULT_TEMPLATES.map((d) => {
      const r = byKey.get(d.key);
      return r
        ? { key: r.key, pushTitle: r.pushTitle ?? undefined, pushBody: r.pushBody ?? undefined, smsBody: r.smsBody ?? undefined, critical: r.critical }
        : d;
    });
  }

  validateSmsBody(body: string): void {
    if (!isGsm7(body)) throw Errors.invalid('sms_not_gsm7', 'SMS text may only use GSM-7 characters (no emoji or curly quotes)');
    const withoutVars = body.replace(/\{\{\s*\w+\s*\}\}/g, '');
    if (gsm7Length(withoutVars) > 160) throw Errors.invalid('sms_too_long', 'SMS text must be 160 characters or fewer');
  }

  private async queue(input: {
    userId: string | null;
    phone: string | null;
    channel: NotificationChannel;
    template: string;
    payload: Record<string, unknown>;
    dedupe?: boolean;
  }): Promise<void> {
    if (input.dedupe) {
      const exists = await this.prisma.notification.findFirst({
        where: { userId: input.userId, channel: input.channel, template: input.template, createdAt: { gte: new Date(Date.now() - 600_000) } },
      });
      if (exists) return;
    }
    const n = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        phone: input.phone,
        channel: input.channel,
        template: input.template,
        payload: input.payload as any,
      },
    });
    await this.jobs.enqueue('notifications', 'notifications.send', { notificationId: n.id }, { jobId: `notif-${n.id}`, attempts: MAX_ATTEMPTS });
  }
}

function stringify(vars: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) if (v !== undefined && v !== null) out[k] = String(v);
  return out;
}

function truncateSms(text: string): string {
  // Strip anything outside GSM-7 that sneaked in through variables (e.g. a name with emoji).
  let clean = '';
  for (const ch of text) clean += isGsm7(ch) ? ch : '?';
  if (gsm7Length(clean) <= 160) return clean;
  let out = '';
  for (const ch of clean) {
    if (gsm7Length(out + ch) > 157) break;
    out += ch;
  }
  return `${out}...`;
}

function isPermanentPushError(err: any): boolean {
  const code = String(err?.code ?? err?.errorInfo?.code ?? '');
  return code.includes('registration-token-not-registered') || code.includes('invalid-registration-token');
}
