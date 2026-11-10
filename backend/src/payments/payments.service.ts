import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { Payment, PaymentPurpose, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { JobsService } from '../jobs/jobs.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WalletService } from '../wallet/wallet.service';
import { OrderTransitionsService } from '../orders/transitions.service';
import { RefundsService } from './refunds.service';
import { PaymentProvidersRegistry } from './providers.registry';
import { PaymentProvider } from './payment-provider';
import { AfterCommit } from '../common/after-commit';
import { AppError, Errors } from '../common/errors';
import { formatKina } from '../common/money';
import { normalisePhone } from '../common/phone';
import { logger } from '../common/logger';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';

const OPEN: Payment['status'][] = ['initiated', 'pending'];
type FinalStatus = 'succeeded' | 'failed' | 'expired';

/**
 * Cell money collections for orders and driver top-ups (§8.3, §8.5): initiate through the provider adapter,
 * then resolve by webhook, by polling getStatus, by an admin (manual adapter), or by timeout → expired.
 * `applyStatus` is the single idempotent place that moves a payment to a final state.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly wallet: WalletService,
    private readonly transitions: OrderTransitionsService,
    private readonly refunds: RefundsService,
    private readonly registry: PaymentProvidersRegistry,
  ) {}

  onModuleInit(): void {
    this.jobs.register('payments.poll', (d) => this.poll(d.paymentId));
    this.jobs.register('payments.timeout', (d) => this.timeout(d.paymentId));
    this.jobs.register('payments.webhook.process', (d) => this.processWebhook(d.webhookEventId));
    this.jobs.register('payments.mock.deliver', (d) =>
      this.ingestWebhook('mock', d.headers, Buffer.from(d.rawBody, 'base64')).then(() => undefined),
    );
    // The mock provider simulates the provider calling our webhook (through the queue, like the real thing).
    this.registry.mock.scheduleWebhook = (rawBody, headers, delayMs) =>
      this.jobs.enqueue('payments', 'payments.mock.deliver', { rawBody: rawBody.toString('base64'), headers }, { delayMs, jobId: `mockwh-${randomUUID()}` });
  }

  // ───────────── Initiation ─────────────

  /** Customer: start (or resume) the cell money collection for a PENDING_PAYMENT order. */
  async startOrderPayment(customerId: string, orderId: string, msisdnInput: string, idempotencyKey: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.customerId !== customerId) throw Errors.notFound('Order');
    if (order.paymentMethod !== 'cellmoney') throw Errors.badRequest('not_cellmoney', 'This order is cash on delivery');
    if (order.status !== 'PENDING_PAYMENT') throw Errors.conflict('order_not_awaiting_payment', 'This order is not waiting for payment');
    const open = await this.prisma.payment.findFirst({ where: { purpose: 'order', purposeId: orderId, status: { in: OPEN } } });
    if (open) return this.view(open);
    const p = await this.initiate({
      purpose: 'order',
      purposeId: order.id,
      baseAmountToea: order.priceToea - order.discountToea,
      msisdn: normalisePhone(msisdnInput),
      reference: order.shortCode,
      idempotencyKey: `order:${order.id}:${idempotencyKey}`,
    });
    return this.view(p);
  }

  /** Driver: top up by cell money. With the manual adapter it lands in the admin approval queue. */
  async startTopup(driverId: string, amountToea: number, msisdnInput: string, idempotencyKey: string) {
    const existing = await this.prisma.topupRequest.findUnique({ where: { idempotencyKey }, include: { payment: true } });
    if (existing) return { topup: existing, payment: existing.payment ? await this.view(existing.payment) : null };
    const msisdn = normalisePhone(msisdnInput);
    const topup = await this.prisma.topupRequest.create({
      data: { driverId, method: 'cellmoney', amountToea, msisdn, idempotencyKey, referenceText: '' },
    });
    const reference = `TU-${topup.id.slice(0, 8).toUpperCase()}`;
    await this.prisma.topupRequest.update({ where: { id: topup.id }, data: { referenceText: reference } });
    const payment = await this.initiate({
      purpose: 'topup',
      purposeId: topup.id,
      baseAmountToea: amountToea,
      msisdn,
      reference,
      idempotencyKey: `topup:${topup.id}`,
      // Drivers pay their own top-up fee; the wallet is credited with the requested amount.
      feeBearerOverride: 'customer',
    });
    await this.prisma.topupRequest.update({ where: { id: topup.id }, data: { paymentId: payment.id } });
    const fresh = await this.prisma.topupRequest.findUniqueOrThrow({ where: { id: topup.id } });
    return { topup: fresh, payment: await this.view(payment) };
  }

  private async initiate(input: {
    purpose: PaymentPurpose;
    purposeId: string;
    baseAmountToea: number;
    msisdn: string;
    reference: string;
    idempotencyKey: string;
    feeBearerOverride?: 'customer' | 'driver' | 'platform';
  }): Promise<Payment> {
    const [adapter, timeoutSec, feePercent, bearerSetting, pollSec] = await Promise.all([
      this.settings.get('payment.cellmoney.adapter'),
      this.settings.get('payment.cellmoney.timeout_sec'),
      this.settings.get('payment.cellmoney.fee_percent'),
      this.settings.get('payment.cellmoney.fee_bearer'),
      this.settings.get('payment.cellmoney.poll_interval_sec'),
    ]);
    const provider = this.registry.get(adapter);
    const bearer = input.feeBearerOverride ?? bearerSetting;
    const fee = Math.floor((input.baseAmountToea * Math.round(feePercent * 100) + 5000) / 10000);
    // If the customer bears the fee they are charged amount + fee; otherwise the fee comes out of the amount.
    const amount = bearer === 'customer' ? input.baseAmountToea + fee : input.baseAmountToea;
    const manualTopup = provider.manual && input.purpose === 'topup';

    let payment: Payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          provider: 'cellmoney',
          adapter: provider.name,
          direction: 'in',
          amountToea: amount,
          feeToea: fee,
          feeBearer: bearer,
          status: 'initiated',
          msisdn: input.msisdn,
          reference: input.reference,
          purpose: input.purpose,
          purposeId: input.purposeId,
          idempotencyKey: input.idempotencyKey,
          expiresAt: manualTopup ? null : new Date(Date.now() + timeoutSec * 1000),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.payment.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
      }
      throw err;
    }

    if (!manualTopup) {
      await this.jobs.enqueue('payments', 'payments.timeout', { paymentId: payment.id }, { delayMs: timeoutSec * 1000, jobId: `paytimeout-${payment.id}` });
    }

    let result: { providerRef: string; status: 'pending' | 'succeeded' | 'failed' };
    try {
      result = await provider.initiateCollection({ amountToea: amount, msisdn: input.msisdn, reference: input.reference, idempotencyKey: payment.idempotencyKey });
    } catch (err: any) {
      logger.error({ err: err.message, paymentId: payment.id }, 'initiateCollection failed');
      // Fail only this attempt; the order stays PENDING_PAYMENT so the customer can retry (the sweeper
      // fails orders left without an open payment past the timeout).
      await this.prisma.payment.update({ where: { id: payment.id }, data: { status: 'failed', failureReason: 'Could not reach the cell money provider' } });
      if (input.purpose === 'topup') {
        await this.prisma.topupRequest.update({ where: { id: input.purposeId }, data: { status: 'failed', rejectReason: 'Provider unavailable' } });
      }
      throw new AppError('provider_unavailable', 'Cell money is not available right now. Try again or pay cash.', HttpStatus.BAD_GATEWAY);
    }
    payment = await this.prisma.payment.update({
      where: { id: payment.id },
      data: { providerRef: result.providerRef, status: payment.status === 'initiated' ? 'pending' : payment.status },
    });
    if (result.status !== 'pending') {
      await this.applyStatus(payment.id, result.status, { source: 'initiate' });
    } else if (!provider.manual) {
      // Fallback in case the webhook never arrives (§8.3).
      await this.jobs.enqueue('payments', 'payments.poll', { paymentId: payment.id }, { delayMs: pollSec * 1000, jobId: `paypoll-${payment.id}-1` });
    }
    return this.prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
  }

  // ───────────── Webhooks ─────────────

  /** Verify, store raw, dedupe, and hand off to a job. The HTTP handler returns 200 immediately after. */
  async ingestWebhook(providerName: string, headers: Record<string, unknown>, rawBody: Buffer): Promise<{ received: true; duplicate: boolean }> {
    const provider = this.registry.get(providerName);
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers ?? {})) lower[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
    const signatureOk = provider.verifyWebhook(lower, rawBody);
    if (!signatureOk) {
      await this.prisma.webhookEvent.create({
        data: { provider: providerName, eventKey: `invalid:${randomUUID()}`, signatureOk: false, headers: lower, rawBody: rawBody.toString('utf8').slice(0, 20000) },
      });
      throw new AppError('invalid_signature', 'Webhook signature verification failed', HttpStatus.UNAUTHORIZED);
    }
    let eventKey: string;
    try {
      const evt = provider.parseWebhook(rawBody);
      eventKey = evt.eventId;
    } catch {
      throw Errors.badRequest('malformed_webhook', 'Webhook body could not be parsed');
    }
    try {
      const row = await this.prisma.webhookEvent.create({
        data: { provider: providerName, eventKey, signatureOk: true, headers: lower, rawBody: rawBody.toString('utf8') },
      });
      await this.jobs.enqueue('payments', 'payments.webhook.process', { webhookEventId: row.id }, { jobId: `webhook-${row.id}` });
      return { received: true, duplicate: false };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return { received: true, duplicate: true };
      throw err;
    }
  }

  async processWebhook(webhookEventId: string): Promise<void> {
    const row = await this.prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
    if (!row || row.processedAt || !row.signatureOk) return;
    try {
      const provider = this.registry.get(row.provider);
      const evt = provider.parseWebhook(Buffer.from(row.rawBody, 'utf8'));
      const payment = await this.prisma.payment.findUnique({ where: { adapter_providerRef: { adapter: provider.name, providerRef: evt.providerRef } } });
      if (!payment) throw new Error(`Unknown providerRef ${evt.providerRef}`);
      if (evt.status !== 'pending') {
        await this.applyStatus(payment.id, evt.status, { source: 'webhook', webhookEventId: row.id, feeToea: evt.feeToea, raw: evt.raw });
      }
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { processedAt: new Date(), error: null } });
    } catch (err: any) {
      await this.prisma.webhookEvent.update({ where: { id: row.id }, data: { error: String(err?.message ?? err).slice(0, 500) } });
      throw err;
    }
  }

  // ───────────── Polling / timeout ─────────────

  async poll(paymentId: string, attempt = 1): Promise<void> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p || !OPEN.includes(p.status) || !p.providerRef) return;
    if (p.expiresAt && p.expiresAt <= new Date()) return; // the timeout job takes over
    const provider = this.registry.get(p.adapter);
    if (provider.manual) return;
    const status = await provider.getStatus(p.providerRef);
    if (status !== 'pending') {
      await this.applyStatus(p.id, status, { source: 'poll' });
      return;
    }
    const pollSec = await this.settings.get('payment.cellmoney.poll_interval_sec');
    await this.jobs.enqueue('payments', 'payments.poll', { paymentId, attempt: attempt + 1 }, { delayMs: pollSec * 1000, jobId: `paypoll-${paymentId}-${attempt + 1}` });
  }

  /** After payment.cellmoney.timeout_sec: one last status check, then expired (§8.3). */
  async timeout(paymentId: string): Promise<void> {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p || !OPEN.includes(p.status)) return;
    if (p.expiresAt && p.expiresAt.getTime() > Date.now() + 2000) return; // fired early (e.g. clock skew)
    const provider = this.registry.get(p.adapter);
    if (!provider.manual && p.providerRef) {
      const status = await provider.getStatus(p.providerRef).catch(() => 'pending' as const);
      if (status !== 'pending') {
        await this.applyStatus(p.id, status, { source: 'timeout-check' });
        return;
      }
    }
    await this.applyStatus(p.id, 'expired', { source: 'timeout', reason: 'Payment not received in time' });
  }

  // ───────────── State changes ─────────────

  /**
   * Move a payment to a final state, once. A success that arrives after the payment expired or the
   * order died is still recorded (the money moved) and triggers a refund for the order.
   */
  async applyStatus(
    paymentId: string,
    status: FinalStatus,
    meta: { source: string; reason?: string; feeToea?: number; raw?: unknown; webhookEventId?: string; adminId?: string },
  ): Promise<Payment> {
    const effects = new AfterCommit();
    const result = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } });
      const lateSuccess = status === 'succeeded' && (p.status === 'expired' || p.status === 'failed');
      if (!OPEN.includes(p.status) && !lateSuccess) return p; // already final: idempotent no-op
      const payload = { ...((p.rawPayload as object) ?? {}), [`${meta.source}:${Date.now()}`]: meta.raw ?? { reason: meta.reason } };
      const updated = await tx.payment.update({
        where: { id: p.id },
        data: {
          status,
          failureReason: status === 'succeeded' ? null : (meta.reason ?? p.failureReason ?? 'Payment failed'),
          settledAt: status === 'succeeded' ? new Date() : null,
          feeToea: meta.feeToea ?? p.feeToea,
          rawPayload: payload as any,
        },
      });
      if (p.purpose === 'order') await this.onOrderPayment(tx, updated, status, effects, meta);
      if (p.purpose === 'topup') await this.onTopupPayment(tx, updated, status, effects, meta);
      return updated;
    });
    await effects.run();
    return result;
  }

  private async onOrderPayment(tx: Tx, p: Payment, status: FinalStatus, effects: AfterCommit, meta: { source: string; adminId?: string; reason?: string }) {
    const order = await this.transitions.lock(tx, p.purposeId);
    const actor = meta.adminId ? { type: 'admin' as const, id: meta.adminId } : { type: 'system' as const, id: null };
    if (status === 'succeeded') {
      const paid = await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'paid' } });
      if (order.status === 'PENDING_PAYMENT') {
        await this.transitions.transition(tx, paid, 'SEARCHING', actor, effects, { metadata: { paymentId: p.id, via: meta.source } });
      } else {
        // Paid after the order failed/was cancelled: give the money back.
        await this.refunds.refundOrderPayment(tx, paid, effects, { reason: 'Payment arrived after the order closed', sourcePaymentId: p.id });
      }
      return;
    }
    if (order.status !== 'PENDING_PAYMENT') return;
    const otherOpen = await tx.payment.count({ where: { purpose: 'order', purposeId: order.id, status: { in: OPEN }, id: { not: p.id } } });
    if (otherOpen > 0) return;
    const failed = await tx.order.update({ where: { id: order.id }, data: { paymentStatus: 'failed' } });
    await this.transitions.transition(tx, failed, 'FAILED', actor, effects, {
      reason: status === 'expired' ? 'Payment timed out' : (meta.reason ?? 'Payment failed'),
      metadata: { paymentId: p.id, via: meta.source },
    });
  }

  private async onTopupPayment(tx: Tx, p: Payment, status: FinalStatus, effects: AfterCommit, meta: { source: string; adminId?: string }) {
    await tx.$queryRaw`SELECT id FROM topup_requests WHERE id = ${p.purposeId}::uuid FOR UPDATE`;
    const topup = await tx.topupRequest.findUniqueOrThrow({ where: { id: p.purposeId } });
    if (status === 'succeeded') {
      if (topup.status === 'approved') return;
      // Credit even if it had been marked failed: the money arrived.
      await this.wallet.creditTopup(tx, topup, meta.adminId ? `admin:${meta.adminId}` : 'system', effects, meta.adminId ?? null);
    } else if (topup.status === 'pending') {
      await tx.topupRequest.update({ where: { id: topup.id }, data: { status: 'failed', rejectReason: status === 'expired' ? 'Payment timed out' : 'Payment failed' } });
    }
  }

  // ───────────── Admin reconciliation ─────────────

  /** Manual adapter: Finance matched the money in the merchant account to this payment's reference. */
  async adminConfirm(adminId: string, paymentId: string, receiptRef: string, ip: string | null) {
    const before = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!before) throw Errors.notFound('Payment');
    if (before.direction !== 'in') throw Errors.badRequest('not_collection', 'Only incoming payments can be confirmed');
    if (before.status === 'succeeded') throw Errors.conflict('already_succeeded', 'This payment is already confirmed');
    const after = await this.applyStatus(paymentId, 'succeeded', { source: 'admin', adminId, raw: { receiptRef } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'payment.confirm', entity: 'payment', entityId: paymentId, before, after: { ...after, receiptRef }, ip });
    return after;
  }

  async adminMarkFailed(adminId: string, paymentId: string, reason: string, ip: string | null) {
    const before = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!before) throw Errors.notFound('Payment');
    if (!OPEN.includes(before.status)) throw Errors.conflict('payment_final', `This payment is already ${before.status}`);
    const after = await this.applyStatus(paymentId, 'failed', { source: 'admin', adminId, reason });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'payment.mark_failed', entity: 'payment', entityId: paymentId, before, after, ip });
    return after;
  }

  /** Re-check status with the provider now. */
  async adminRecheck(adminId: string, paymentId: string) {
    const p = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!p) throw Errors.notFound('Payment');
    const provider: PaymentProvider = this.registry.get(p.adapter);
    if (provider.manual || !p.providerRef) throw Errors.badRequest('manual_payment', 'Manual payments are confirmed by matching the reference');
    const status = await provider.getStatus(p.providerRef);
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'payment.recheck', entity: 'payment', entityId: p.id, after: { providerStatus: status } });
    if (status !== 'pending') return this.applyStatus(p.id, status, { source: 'admin-recheck', adminId });
    return p;
  }

  async list(where: Prisma.PaymentWhereInput, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.payment.findMany({ where: { AND: [where, cursorWhere(q.cursor)] }, orderBy: pageOrder, take: limit + 1 });
    return toPage(rows, limit);
  }

  /** What apps show: status plus payment instructions for the manual adapter. */
  async view(p: Payment) {
    const provider = this.registry.get(p.adapter);
    const merchant = await this.settings.get('payment.cellmoney.merchant_number');
    return {
      id: p.id,
      status: p.status,
      amountToea: p.amountToea,
      feeToea: p.feeToea,
      reference: p.reference,
      expiresAt: p.expiresAt,
      failureReason: p.failureReason,
      manual: provider.manual,
      instructions: provider.manual
        ? `Send ${formatKina(p.amountToea)} by cell money to ${merchant || 'the Cooper Waters merchant number'} with reference ${p.reference}.`
        : 'Approve the payment request on your phone.',
    };
  }
}
