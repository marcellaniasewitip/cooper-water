import { Injectable } from '@nestjs/common';
import { ActorType, DisputeStatus, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { LedgerService } from '../wallet/ledger.service';
import { RefundsService } from '../payments/refunds.service';
import { OrderTransitionsService } from '../orders/transitions.service';
import { AfterCommit } from '../common/after-commit';
import { Errors } from '../common/errors';
import { isDisputable } from '../orders/state-machine';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';

export type DisputeOutcome = 'favour_driver' | 'favour_customer';

/**
 * Disputes (§5, §6): raising one flags the order DISPUTED and holds settlement. Resolution returns the
 * order to where it was (favour driver), or cancels/refunds (favour customer).
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly ledger: LedgerService,
    private readonly refunds: RefundsService,
    private readonly transitions: OrderTransitionsService,
  ) {}

  async categories(): Promise<string[]> {
    return this.settings.get('dispute.categories');
  }

  async raise(actor: { type: 'customer' | 'driver'; userId: string; driverId?: string }, orderId: string, category: string, description: string) {
    const categories = await this.categories();
    if (!categories.includes(category)) throw Errors.invalid('unknown_category', `Category must be one of: ${categories.join(', ')}`);
    const effects = new AfterCommit();
    const dispute = await this.prisma.tx(async (tx) => {
      const order = await this.transitions.lock(tx, orderId);
      const owns = actor.type === 'customer' ? order.customerId === actor.userId : order.driverId === actor.driverId;
      if (!owns) throw Errors.notFound('Order');
      const open = await tx.dispute.count({ where: { orderId, status: { in: ['open', 'investigating'] } } });
      if (open > 0 && order.status === 'DISPUTED') {
        throw Errors.conflict('dispute_open', 'There is already an open issue for this order. Our team is looking into it.');
      }
      if (order.status !== 'DISPUTED') {
        if (!isDisputable(order.status)) throw Errors.conflict('not_disputable', 'Issues can only be reported on accepted or delivered orders');
        await this.transitions.transition(tx, order, 'DISPUTED', { type: actor.type as ActorType, id: actor.type === 'driver' ? actor.driverId! : actor.userId }, effects, {
          metadata: { category },
        });
      }
      return tx.dispute.create({
        data: { orderId, raisedById: actor.userId, raisedByType: actor.type, category, description },
      });
    });
    await effects.run();
    return dispute;
  }

  async list(q: CursorQuery & { status?: string }) {
    const limit = pageLimit(q);
    const where: Prisma.DisputeWhereInput = q.status ? { status: { in: q.status.split(',') as DisputeStatus[] } } : {};
    const rows = await this.prisma.dispute.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { order: { select: { id: true, shortCode: true, status: true, priceToea: true, paymentMethod: true } }, raisedBy: { select: { name: true, phone: true, role: true } } },
    });
    return toPage(rows, limit);
  }

  async get(id: string) {
    const d = await this.prisma.dispute.findUnique({ where: { id }, include: { order: true, raisedBy: { select: { id: true, name: true, phone: true, role: true } } } });
    if (!d) throw Errors.notFound('Dispute');
    return d;
  }

  async investigate(adminId: string, id: string, ip: string | null) {
    const before = await this.get(id);
    if (before.status !== 'open') throw Errors.conflict('dispute_state', `This dispute is ${before.status}`);
    const after = await this.prisma.dispute.update({ where: { id }, data: { status: 'investigating' } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'dispute.investigate', entity: 'dispute', entityId: id, before, after, ip });
    return after;
  }

  /**
   * reject / favour_driver → order returns to its pre-dispute status (DELIVERED → COMPLETED, settling).
   * favour_customer → not yet delivered: CANCELLED (+refund if paid by cell money);
   *                   delivered/completed: COMPLETED + refund `refundToea` (cell money via provider,
   *                   COD as a manual cash refund task) and claw back the refund from the driver's wallet.
   */
  async resolve(adminId: string, id: string, input: { decision: 'reject' | DisputeOutcome; notes: string; refundToea?: number }, ip: string | null) {
    const effects = new AfterCommit();
    const result = await this.prisma.tx(async (tx) => {
      const dispute = await tx.dispute.findUnique({ where: { id } });
      if (!dispute) throw Errors.notFound('Dispute');
      if (dispute.status === 'resolved' || dispute.status === 'rejected') throw Errors.conflict('dispute_closed', 'This dispute is already closed');
      const order = await this.transitions.lock(tx, dispute.orderId);
      const refundToea = input.decision === 'favour_customer' ? Math.min(input.refundToea ?? order.priceToea, order.priceToea) : 0;
      const updated = await tx.dispute.update({
        where: { id },
        data: {
          status: input.decision === 'reject' ? 'rejected' : 'resolved',
          outcome: input.decision === 'reject' ? null : input.decision,
          refundToea: input.decision === 'favour_customer' ? refundToea : null,
          resolutionNotes: input.notes,
          resolvedBy: adminId,
          resolvedAt: new Date(),
        },
      });
      const stillOpen = await tx.dispute.count({ where: { orderId: order.id, status: { in: ['open', 'investigating'] } } });
      if (order.status === 'DISPUTED' && stillOpen === 0) {
        const prior = (order.statusBeforeDispute ?? 'DELIVERED') as OrderStatus;
        const delivered = prior === 'DELIVERED' || prior === 'COMPLETED';
        const admin = { type: 'admin' as const, id: adminId };
        if (input.decision !== 'favour_customer') {
          await this.transitions.transition(tx, order, prior === 'DELIVERED' ? 'COMPLETED' : prior, admin, effects, { metadata: { disputeId: id, decision: input.decision } });
        } else if (!delivered) {
          await this.transitions.transition(tx, order, 'CANCELLED', admin, effects, { reason: `Dispute resolved: ${input.notes}`, refundToea, metadata: { disputeId: id } });
        } else {
          const completed = await this.transitions.transition(tx, order, 'COMPLETED', admin, effects, { metadata: { disputeId: id, decision: input.decision } });
          if (refundToea > 0) await this.refundDelivered(tx, completed, refundToea, input.notes, adminId, effects);
        }
      } else if (input.decision === 'favour_customer' && refundToea > 0 && (order.status === 'COMPLETED' || order.status === 'DELIVERED')) {
        await this.refundDelivered(tx, order, refundToea, input.notes, adminId, effects);
      }
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: `dispute.${input.decision}`, entity: 'dispute', entityId: id, before: dispute, after: updated, ip }, tx);
      return updated;
    });
    await effects.run();
    return result;
  }

  private async refundDelivered(tx: Prisma.TransactionClient, order: { id: string; driverId: string | null; paymentMethod: string; shortCode: string } & any, refundToea: number, notes: string, adminId: string, effects: AfterCommit) {
    if (order.paymentMethod === 'cellmoney' || order.paymentMethod === 'account') {
      await this.refunds.refundOrderPayment(tx, order, effects, { amountToea: refundToea, reason: `Dispute: ${notes}` });
    } else {
      await this.refunds.createCashRefundTask(tx, order, refundToea, `Dispute: ${notes}`);
    }
    // The driver was paid for this order; recover the refunded amount from their wallet.
    if (order.driverId && (order.paymentMethod === 'cellmoney' || order.paymentMethod === 'account')) {
      const wallet = await this.ledger.driverWallet(order.driverId, tx);
      await this.ledger.post(tx, {
        walletId: wallet.id,
        amountToea: -refundToea,
        type: 'adjustment',
        referenceType: 'order',
        referenceId: order.id,
        idempotencyKey: `clawback:${order.id}`,
        createdBy: `admin:${adminId}`,
        description: `Refund to customer for ${order.shortCode} (dispute)`,
      });
    }
  }
}
