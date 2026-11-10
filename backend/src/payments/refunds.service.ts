import { Injectable, OnModuleInit } from '@nestjs/common';
import { Order, Payment } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditService } from '../audit/audit.service';
import { PaymentProvidersRegistry } from './providers.registry';
import { AfterCommit } from '../common/after-commit';
import { formatKina } from '../common/money';
import { Errors } from '../common/errors';
import { logger } from '../common/logger';
import { LedgerService } from '../wallet/ledger.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * Refunds (§8.4): cancelled/expired after a successful cell money payment, late payments on a dead order,
 * or a dispute resolved for the customer. Uses provider.refund when supported; otherwise the refund
 * Payment stays `pending` as a manual task in the admin dashboard.
 */
@Injectable()
export class RefundsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly registry: PaymentProvidersRegistry,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly realtime: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.jobs.register('payments.refund.execute', (d) => this.execute(d.paymentId));
  }

  /** Create a refund for the order's successful cell money payment (no-op if none / already refunding). */
  async refundOrderPayment(
    tx: Tx,
    order: Order,
    effects: AfterCommit,
    opts: { amountToea?: number; reason: string; sourcePaymentId?: string },
  ): Promise<Payment | null> {
    if (order.paymentMethod === 'wallet') {
      await this.refundToWallet(tx, order, effects, opts);
      return null;
    }
    const source = opts.sourcePaymentId
      ? await tx.payment.findUnique({ where: { id: opts.sourcePaymentId } })
      : await tx.payment.findFirst({
          where: { purpose: 'order', purposeId: order.id, direction: 'in', status: 'succeeded' },
          orderBy: { createdAt: 'desc' },
        });
    if (!source || source.status !== 'succeeded') return null;
    const amount = Math.min(opts.amountToea ?? source.amountToea, source.amountToea);
    if (amount <= 0) return null;
    const idempotencyKey = `refund:${source.id}`;
    const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    const refund = await tx.payment.create({
      data: {
        provider: source.provider,
        adapter: source.adapter,
        direction: 'out',
        amountToea: amount,
        status: 'initiated',
        msisdn: source.msisdn,
        reference: order.shortCode,
        purpose: 'refund',
        purposeId: order.id,
        rawPayload: { sourcePaymentId: source.id, reason: opts.reason },
        idempotencyKey,
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'refund_pending' } });
    effects.add(() => this.jobs.enqueue('payments', 'payments.refund.execute', { paymentId: refund.id }, { jobId: `refund-${refund.id}` }));
    return refund;
  }

  /** Wallet-paid order: credit the customer's wallet straight back (instant, no provider). Idempotent. */
  private async refundToWallet(tx: Tx, order: Order, effects: AfterCommit, opts: { amountToea?: number; reason: string }): Promise<void> {
    const paid = order.priceToea - order.discountToea;
    const amount = Math.min(opts.amountToea ?? paid, paid);
    if (amount <= 0) return;
    const wallet = await this.ledger.customerWallet(order.customerId, tx);
    const { created } = await this.ledger.post(tx, {
      walletId: wallet.id,
      amountToea: amount,
      type: 'refund',
      referenceType: 'order',
      referenceId: order.id,
      idempotencyKey: `wallet-refund:${order.id}`,
      createdBy: 'system',
      description: `Refund for ${order.shortCode}`,
    });
    if (!created) return;
    await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'refunded' } });
    const after = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    effects.add(async () => {
      this.realtime.toUser(order.customerId, 'wallet.updated', { balanceToea: after.balanceToea });
      await this.notifications.notify(order.customerId, 'refund.issued', { shortCode: order.shortCode, amount: formatKina(amount), reason: opts.reason });
    });
  }

  /** Manual cash refund task (COD disputes resolved for the customer). */
  async createCashRefundTask(tx: Tx, order: Order, amountToea: number, reason: string): Promise<Payment> {
    const idempotencyKey = `refund:cash:${order.id}`;
    const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    return tx.payment.create({
      data: {
        provider: 'cash',
        adapter: 'cash',
        direction: 'out',
        amountToea,
        status: 'pending',
        reference: order.shortCode,
        purpose: 'refund',
        purposeId: order.id,
        rawPayload: { reason },
        failureReason: 'Manual refund required',
        idempotencyKey,
      },
    });
  }

  /** Job: try the provider refund. Idempotent (provider gets the same idempotency key every time). */
  async execute(paymentId: string): Promise<void> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p || p.purpose !== 'refund' || ['succeeded', 'failed', 'reversed'].includes(p.status)) return;
    const sourceId = (p.rawPayload as any)?.sourcePaymentId as string | undefined;
    const source = sourceId ? await this.prisma.payment.findUnique({ where: { id: sourceId } }) : null;
    if (!source?.providerRef) {
      await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'pending', failureReason: 'Manual refund required' } });
      return;
    }
    const provider = this.registry.get(p.adapter);
    const result = await provider.refund({ providerRef: source.providerRef, amountToea: p.amountToea, idempotencyKey: p.idempotencyKey });
    logger.info({ paymentId, result: result.status }, 'refund attempted');
    if (result.status === 'succeeded') {
      await this.complete(p.id, result.providerRef ?? null, null);
    } else if (result.status === 'unsupported') {
      await this.prisma.payment.update({
        where: { id: p.id },
        data: { status: 'pending', failureReason: result.message ?? 'Manual refund required' },
      });
    } else if (result.status === 'pending') {
      await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'pending', providerRef: result.providerRef ?? p.providerRef } });
      await this.jobs.enqueue('payments', 'payments.refund.execute', { paymentId: p.id }, { delayMs: 60_000, jobId: `refund-${p.id}-${Date.now()}` });
    } else {
      await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'failed', failureReason: result.message ?? 'Provider refund failed' } });
    }
  }

  /** Mark a refund as paid (provider confirmed, or Finance paid it manually). */
  async complete(paymentId: string, externalRef: string | null, adminId: string | null): Promise<void> {
    const done = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      if (p.purpose !== 'refund') throw Errors.badRequest('not_a_refund', 'This payment is not a refund');
      if (p.status === 'succeeded') return null;
      const updated = await tx.payment.update({
        where: { id: p.id },
        data: {
          status: 'succeeded',
          settledAt: new Date(),
          failureReason: null,
          providerRef: externalRef ? (p.adapter === 'cash' ? `cash-${externalRef}` : externalRef) : p.providerRef,
        },
      });
      const order = await tx.order.update({ where: { id: p.purposeId }, data: { paymentStatus: 'refunded' } });
      if (adminId) {
        await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'refund.complete', entity: 'payment', entityId: p.id, before: p, after: updated }, tx);
      }
      return { order, amount: p.amountToea };
    });
    if (done) {
      await this.notifications.notify(done.order.customerId, 'refund.issued', { amount: formatKina(done.amount), shortCode: done.order.shortCode });
    }
  }

  /** Admin: retry a failed provider refund. */
  async retry(paymentId: string, adminId: string): Promise<void> {
    const p = await this.prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    if (p.purpose !== 'refund' || p.status === 'succeeded') throw Errors.badRequest('not_retryable', 'Only open refunds can be retried');
    await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'initiated', failureReason: null } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'refund.retry', entity: 'payment', entityId: p.id });
    await this.execute(p.id);
  }
}
