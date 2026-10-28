import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { JobsService } from './jobs.service';
import { logger } from '../common/logger';

const GRACE_MS = 30_000;

/**
 * Runs every minute (§6): catches anything a lost delayed job would have handled. Every step calls the
 * same idempotent handler the original job would have, so running it alongside the real jobs is safe.
 */
@Injectable()
export class SweeperService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('maintenance.sweep', () => this.sweep().then(() => undefined));
  }

  async sweep(now = new Date()): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    const step = async (name: string, ids: string[], run: (id: string) => Promise<void>) => {
      counts[name] = ids.length;
      for (const id of ids) {
        try {
          await run(id);
        } catch (err: any) {
          logger.warn({ step: name, id, err: err?.message }, 'sweeper step failed');
        }
      }
    };
    const before = new Date(now.getTime() - GRACE_MS);

    const searching = await this.prisma.order.findMany({ where: { status: 'SEARCHING', expiresAt: { lt: before } }, select: { id: true, dispatchRound: true }, take: 200 });
    await step('searching_expired', searching.map((o) => `${o.id}|${o.dispatchRound}`), async (v) => {
      const [orderId, round] = v.split('|');
      await this.jobs.run('dispatch.round_timeout', { orderId, round: Number(round) });
    });

    const autoSec = await this.settings.get('order.auto_complete_after_sec');
    const delivered = await this.prisma.order.findMany({
      where: { status: 'DELIVERED', deliveredAt: { lt: new Date(before.getTime() - autoSec * 1000) } },
      select: { id: true },
      take: 200,
    });
    await step('auto_complete', delivered.map((o) => o.id), (id) => this.jobs.run('orders.auto_complete', { orderId: id }));

    const payments = await this.prisma.payment.findMany({
      where: { direction: 'in', status: { in: ['initiated', 'pending'] }, expiresAt: { lt: before } },
      select: { id: true },
      take: 200,
    });
    await step('payment_timeout', payments.map((p) => p.id), (id) => this.jobs.run('payments.timeout', { paymentId: id }));

    // Cell money orders whose payment attempt failed to start and were never retried.
    const timeoutSec = await this.settings.get('payment.cellmoney.timeout_sec');
    const stuck = await this.prisma.order.findMany({
      where: { status: 'PENDING_PAYMENT', createdAt: { lt: new Date(before.getTime() - timeoutSec * 1000) } },
      select: { id: true },
      take: 200,
    });
    await step('pending_payment_orphans', stuck.map((o) => o.id), async (orderId) => {
      const open = await this.prisma.payment.count({ where: { purpose: 'order', purposeId: orderId, status: { in: ['initiated', 'pending'] } } });
      if (open === 0) await this.jobs.run('orders.fail_unpaid', { orderId });
    });

    const refunds = await this.prisma.payment.findMany({
      where: { purpose: 'refund', status: 'initiated', createdAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
      select: { id: true },
      take: 100,
    });
    await step('refund_retry', refunds.map((p) => p.id), (id) => this.jobs.run('payments.refund.execute', { paymentId: id }));

    const webhooks = await this.prisma.webhookEvent.findMany({
      where: { processedAt: null, signatureOk: true, createdAt: { lt: new Date(now.getTime() - 2 * 60_000) } },
      select: { id: true },
      take: 100,
    });
    await step('webhook_retry', webhooks.map((w) => w.id), (id) => this.jobs.run('payments.webhook.process', { webhookEventId: id }));

    // Drivers whose app went silent: take them offline so they stop receiving offers.
    const staleSec = await this.settings.get('driver.location_stale_sec');
    const offline = await this.prisma.driver.updateMany({
      where: { online: true, lastSeenAt: { lt: new Date(now.getTime() - Math.max(staleSec * 5, 600) * 1000) } },
      data: { online: false },
    });
    counts.drivers_auto_offline = offline.count;

    // Sign-in codes are kept on notifications only while they can be used or re-sent; then removed.
    counts.otp_codes_redacted = await this.prisma.$executeRaw`
      UPDATE notifications SET payload = payload - 'code'
      WHERE template = 'auth.otp' AND payload ? 'code' AND created_at < ${new Date(now.getTime() - 30 * 60_000)}`;

    // Idempotency records are only needed for retries; keep a week.
    const purged = await this.prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } } });
    counts.idempotency_purged = purged.count;

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) logger.info({ counts }, 'sweeper');
    return counts;
  }
}
