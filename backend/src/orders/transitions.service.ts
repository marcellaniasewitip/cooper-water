import { HttpStatus, Injectable } from '@nestjs/common';
import { ActorType, Order, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { JobsService } from '../jobs/jobs.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AfterCommit } from '../common/after-commit';
import { AppError, Errors } from '../common/errors';
import { formatKina } from '../common/money';
import { SettlementService } from './settlement.service';
import { RefundsService } from '../payments/refunds.service';
import { PromosService } from '../promos/promos.service';
import { STATUS_TIMESTAMP, canTransition } from './state-machine';
import { ORDER_INCLUDE, customerOrderView, driverOrderView, adminOrderView } from './order-views';

export interface Actor {
  type: ActorType;
  id: string | null;
}

export interface TransitionOptions {
  metadata?: Record<string, unknown>;
  /** Extra columns to set with the status change (e.g. driverId on accept). */
  data?: Prisma.OrderUncheckedUpdateInput;
  /** Override refund amount on CANCELLED (disputes). 0 = no refund. */
  refundToea?: number;
  reason?: string;
}

/** Customer-facing template per status. */
const CUSTOMER_TEMPLATES: Partial<Record<OrderStatus, string>> = {
  PENDING_PAYMENT: 'order.payment_pending',
  SEARCHING: 'order.searching',
  ACCEPTED: 'order.accepted',
  LOADING: 'order.loading',
  EN_ROUTE: 'order.en_route',
  ARRIVED: 'order.arrived',
  DELIVERED: 'order.delivered',
  COMPLETED: 'order.completed',
  CANCELLED: 'order.cancelled',
  EXPIRED: 'order.expired',
  FAILED: 'payment.failed',
  DISPUTED: 'order.disputed',
};

/**
 * Applies the state machine (§6). Every transition: validated, row-locked, written to OrderEvent inside the
 * caller's transaction, with notifications/websocket pushes/jobs queued to run after commit.
 */
@Injectable()
export class OrderTransitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly settlement: SettlementService,
    private readonly refunds: RefundsService,
    private readonly promos: PromosService,
  ) {}

  /** SELECT … FOR UPDATE on the order row. */
  async lock(tx: Tx, orderId: string): Promise<Order> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE`);
    if (!rows[0]) throw Errors.notFound('Order');
    return tx.order.findUniqueOrThrow({ where: { id: orderId } });
  }

  async transition(tx: Tx, order: Order, to: OrderStatus, actor: Actor, effects: AfterCommit, opts: TransitionOptions = {}): Promise<Order> {
    const from = order.status;
    if (!canTransition(from, to, actor.type)) {
      throw new AppError('invalid_transition', `This order is ${humanStatus(from)} and can't be changed to ${humanStatus(to)}`, HttpStatus.CONFLICT, {
        from,
        to,
      });
    }
    const now = new Date();
    const data: Prisma.OrderUncheckedUpdateInput = { ...opts.data, status: to, [STATUS_TIMESTAMP[to]]: now };
    if (to === 'DISPUTED') data.statusBeforeDispute = from;
    if (from === 'DISPUTED') data.statusBeforeDispute = null;
    if (to === 'CANCELLED' && opts.reason) data.cancelReason = opts.reason;

    let round: number | null = null;
    if (to === 'SEARCHING') {
      // Entering (or re-entering after a reassign) dispatch: start at round 1.
      const window = await this.roundWindowSec();
      round = 1;
      data.dispatchRound = 1;
      data.expiresAt = new Date(now.getTime() + window * 1000);
      data.driverId = null;
    }

    // Reassign/cancel/expire before settlement: hand an acceptance-time commission back to the old driver.
    if ((to === 'SEARCHING' || to === 'CANCELLED' || (to === 'ACCEPTED' && from !== 'SEARCHING' && from !== 'DISPUTED')) && order.commissionDeducted && !order.settledAt) {
      await this.settlement.reverseCommission(tx, order, effects);
    }

    let updated = await tx.order.update({ where: { id: order.id }, data });
    await tx.orderEvent.create({
      data: {
        orderId: order.id,
        // A COD order is created straight into dispatch; record it as a creation, not a payment step.
        fromStatus: opts.metadata?.created ? null : from,
        toStatus: to,
        actorType: actor.type,
        actorId: actor.id,
        metadata: (opts.metadata ?? (opts.reason ? { reason: opts.reason } : undefined)) as any,
      },
    });

    // ── Money hooks (same transaction) ──
    if (to === 'ACCEPTED') await this.settlement.onAccepted(tx, updated, effects);
    if (to === 'COMPLETED') await this.settlement.settle(tx, updated, effects);
    // An order that never completed gives the promo use back.
    if ((to === 'CANCELLED' || to === 'EXPIRED' || to === 'FAILED') && updated.promoCodeId) await this.promos.release(tx, updated.id);
    if ((to === 'CANCELLED' || to === 'EXPIRED') && updated.paymentStatus === 'paid' && opts.refundToea !== 0) {
      await this.refunds.refundOrderPayment(tx, updated, effects, {
        amountToea: opts.refundToea,
        reason: to === 'EXPIRED' ? 'Order expired: no driver accepted' : `Order cancelled: ${opts.reason ?? ''}`.trim(),
      });
    }
    updated = await tx.order.findUniqueOrThrow({ where: { id: order.id } });

    // ── After commit ──
    const final = updated;
    if (round !== null) {
      const windowMs = final.expiresAt ? final.expiresAt.getTime() - now.getTime() : 0;
      effects.add(() => this.jobs.run('dispatch.broadcast', { orderId: final.id, round: 1 }));
      effects.add(() =>
        this.jobs.enqueue('orders', 'dispatch.round_timeout', { orderId: final.id, round: 1, epoch: now.getTime() }, {
          delayMs: windowMs,
          jobId: `round-${final.id}-1-${now.getTime()}`,
        }),
      );
    }
    if (to === 'DELIVERED') {
      const after = await this.settings.get('order.auto_complete_after_sec');
      effects.add(() =>
        this.jobs.enqueue('orders', 'orders.auto_complete', { orderId: final.id }, { delayMs: after * 1000, jobId: `autocomplete-${final.id}-${now.getTime()}` }),
      );
    }
    effects.add(() => this.publish(final.id, from, to, order.driverId, opts));
    return updated;
  }

  /** Each broadcast round gets an equal share of the total acceptance timeout (§4). */
  async roundWindowSec(): Promise<number> {
    const [total, extra] = await Promise.all([this.settings.get('order.acceptance_timeout_sec'), this.settings.get('order.rebroadcast_rounds')]);
    return Math.max(15, Math.floor(total / (1 + extra)));
  }

  /** Websocket + push after commit. */
  private async publish(orderId: string, from: OrderStatus, to: OrderStatus, previousDriverId: string | null, opts: TransitionOptions): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!order) return;
    this.realtime.toUser(order.customerId, 'order.updated', { order: customerOrderView(order) });
    if (order.driver) this.realtime.toUser(order.driver.userId, 'order.updated', { order: driverOrderView(order) });
    this.realtime.toAdmins('order.updated', { order: adminOrderView(order) });

    const template = CUSTOMER_TEMPLATES[to];
    if (template && !(to === 'SEARCHING' && from !== 'PENDING_PAYMENT')) {
      const truck = order.driver?.trucks?.[0];
      await this.notifications.notify(order.customerId, template, {
        shortCode: order.shortCode,
        driverName: order.driver?.user?.name ?? 'Your driver',
        plate: truck?.plate ?? '',
        amount: formatKina(order.priceToea - order.discountToea),
        reason: opts.reason ?? '',
        instructions: '',
      });
    }
    // Tell a driver who lost the job (cancel or reassign).
    if (previousDriverId && (to === 'CANCELLED' || to === 'SEARCHING' || (to === 'ACCEPTED' && order.driverId !== previousDriverId))) {
      const prev = await this.prisma.driver.findUnique({ where: { id: previousDriverId } });
      if (prev) {
        this.realtime.toUser(prev.userId, 'order.updated', { order: { id: order.id, shortCode: order.shortCode, status: 'CANCELLED' } });
        await this.notifications.notify(prev.userId, 'driver.order_cancelled', { shortCode: order.shortCode, reason: opts.reason ?? '' });
      }
    }
    // Close out open offers when an order leaves SEARCHING.
    if (from === 'SEARCHING' && to !== 'SEARCHING') {
      const offers = await this.prisma.orderOffer.findMany({ where: { orderId, response: null }, include: { driver: true } });
      if (offers.length) {
        await this.prisma.orderOffer.updateMany({ where: { orderId, response: null }, data: { response: 'missed', respondedAt: new Date() } });
        for (const o of offers) {
          if (o.driverId === order.driverId) continue;
          this.realtime.toUser(o.driver.userId, 'order.offer_revoked', { orderId, reason: to === 'ACCEPTED' ? 'taken' : to.toLowerCase() });
        }
      }
    }
  }
}

export function humanStatus(s: OrderStatus): string {
  return s.toLowerCase().replace('_', ' ');
}
