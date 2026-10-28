import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { NotificationChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { logger } from '../common/logger';
import { PUSH_PROVIDER, PushProvider } from './push.provider';
import { SMS_PROVIDER, SmsProvider, gsm7Length, isGsm7 } from './sms.provider';
import { DEFAULT_TEMPLATES, TemplateDef, render } from './templates';
import { WHATSAPP_PROVIDER, WhatsAppProvider, WhatsAppStatus } from './whatsapp.provider';
import { SettingsService } from '../settings/settings.service';
import { Errors } from '../common/errors';

export type OtpChannel = 'whatsapp' | 'sms';
const OTP_TEMPLATE = 'auth.otp';
/** WhatsApp statuses only move forward; webhooks can arrive out of order. */
const STATUS_RANK: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 };

const MAX_ATTEMPTS = 5;

/**
 * Push first; SMS for critical events, or when push isn't delivered (§9).
 * Sign-in codes go by WhatsApp first when it's configured, with SMS as the fallback.
 * Every send is a Notification row processed by a queued job with exponential backoff.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider | null,
    private readonly settings: SettingsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('notifications.send', (d) => this.deliver(d.notificationId));
    this.jobs.register('notifications.otp_fallback', (d) => this.otpFallback(d.notificationId, d.reason).then(() => undefined));
  }

  get whatsappEnabled(): boolean {
    return this.whatsapp !== null;
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

  /**
   * Send a sign-in code. WhatsApp first (when configured and not overridden), falling back to SMS
   * immediately if WhatsApp refuses the message, and later if it reports the message undeliverable
   * or hasn't confirmed delivery within `otp.whatsapp_fallback_sec`. Returns the channel used now.
   */
  async sendOtp(phone: string, code: string, ttlSec: number, opts: { otpId: string; prefer?: OtpChannel }): Promise<OtpChannel> {
    const payload = { code, minutes: Math.ceil(ttlSec / 60), otpId: opts.otpId };
    const primary = await this.settings.get('otp.primary_channel');
    if (this.whatsapp && opts.prefer !== 'sms' && primary === 'whatsapp') {
      const n = await this.prisma.notification.create({ data: { phone, channel: 'whatsapp', template: OTP_TEMPLATE, payload } });
      try {
        const { messageId } = await this.whatsapp.sendOtp(phone, code);
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { status: 'sent', sentAt: new Date(), attempts: 1, providerMessageId: messageId, deliveryStatus: 'accepted' },
        });
        const waitSec = await this.settings.get('otp.whatsapp_fallback_sec');
        await this.jobs.enqueue('notifications', 'notifications.otp_fallback', { notificationId: n.id, reason: 'timeout' }, {
          delayMs: waitSec * 1000,
          jobId: `otp-fallback-${n.id}`,
        });
        return 'whatsapp';
      } catch (err: any) {
        logger.warn({ phone, err: err?.message, code: err?.code }, 'whatsapp otp refused, using sms');
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { status: 'failed', attempts: 1, deliveryStatus: 'failed', fallbackAt: new Date(), lastError: String(err?.message ?? err).slice(0, 500) },
        });
      }
    }
    await this.sendOtpSms(phone, payload);
    return 'sms';
  }

  /** "Send by SMS instead": re-send the current code by SMS (once per code). */
  async resendOtpBySms(phone: string, otpId: string): Promise<OtpChannel> {
    const n = await this.prisma.notification.findFirst({
      where: { phone, template: OTP_TEMPLATE, payload: { path: ['otpId'], equals: otpId } },
      orderBy: { createdAt: 'asc' },
    });
    if (!n) throw Errors.invalid('otp_expired', 'The code has expired. Request a new one.');
    if (n.channel === 'whatsapp') await this.otpFallback(n.id, 'user');
    return 'sms';
  }

  /**
   * Re-send a WhatsApp sign-in code by SMS, at most once, and only while the code can still be used.
   * `timeout` skips it when WhatsApp already confirmed delivery.
   */
  async otpFallback(notificationId: string, reason: 'timeout' | 'failed' | 'user'): Promise<boolean> {
    const n = await this.prisma.notification.findUnique({ where: { id: notificationId } });
    if (!n || n.channel !== 'whatsapp' || n.template !== OTP_TEMPLATE || n.fallbackAt || !n.phone) return false;
    if (reason === 'timeout' && (n.deliveryStatus === 'delivered' || n.deliveryStatus === 'read')) return false;
    const payload = (n.payload ?? {}) as { code?: string; minutes?: number; otpId?: string };
    if (!payload.code || !payload.otpId) return false;
    const otp = await this.prisma.otpCode.findUnique({ where: { id: payload.otpId } });
    if (!otp || otp.usedAt || otp.expiresAt <= new Date()) return false;
    // Claim the fallback so concurrent triggers (timer, webhook, user tap) send one SMS.
    const claimed = await this.prisma.notification.updateMany({ where: { id: n.id, fallbackAt: null }, data: { fallbackAt: new Date() } });
    if (claimed.count !== 1) return false;
    logger.info({ notificationId, reason }, 'otp fallback to sms');
    await this.sendOtpSms(n.phone, payload as Record<string, unknown>);
    return true;
  }

  /** Apply WhatsApp delivery statuses from Meta's webhook; undeliverable sign-in codes fall back to SMS. */
  async applyWhatsAppStatuses(statuses: WhatsAppStatus[]): Promise<void> {
    for (const st of statuses) {
      const n = await this.prisma.notification.findUnique({ where: { providerMessageId: st.messageId } });
      if (!n) continue;
      if (st.status === 'failed') {
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { deliveryStatus: 'failed', status: 'failed', lastError: `WhatsApp ${st.errorCode ?? ''} ${st.errorTitle ?? ''}`.trim() },
        });
        if (n.template === OTP_TEMPLATE) {
          await this.jobs.enqueue('notifications', 'notifications.otp_fallback', { notificationId: n.id, reason: 'failed' }, { jobId: `otp-fallback-failed-${n.id}` });
        }
        continue;
      }
      const current = STATUS_RANK[n.deliveryStatus ?? 'accepted'] ?? 0;
      if (n.deliveryStatus !== 'failed' && (STATUS_RANK[st.status] ?? -1) > current) {
        await this.prisma.notification.update({ where: { id: n.id }, data: { deliveryStatus: st.status } });
      }
    }
  }

  /** SMS goes straight out (time-critical); on failure it falls back to the retry queue. */
  private async sendOtpSms(phone: string, payload: Record<string, unknown>): Promise<void> {
    const n = await this.prisma.notification.create({ data: { phone, channel: 'sms', template: OTP_TEMPLATE, payload: payload as any } });
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
    if (n.channel === 'whatsapp') return; // sent directly by sendOtp; never re-sent through this path
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
