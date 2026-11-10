import { Injectable } from '@nestjs/common';
import { Order } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { LedgerService } from '../wallet/ledger.service';
import { SettingsService } from '../settings/settings.service';
import { AfterCommit } from '../common/after-commit';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { formatKina } from '../common/money';
import { ReferralsService } from '../referrals/referrals.service';

/**
 * Commission and settlement (§8.2, §8.3). All entries carry deterministic idempotency keys so
 * running any step twice (retries, sweeper, duplicate webhooks) never moves money twice.
 */
@Injectable()
export class SettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly referrals: ReferralsService,
  ) {}

  /** On ACCEPTED with commission.deduct_at = acceptance: take commission from the driver's wallet. */
  async onAccepted(tx: Tx, order: Order, effects: AfterCommit): Promise<void> {
    if (order.commissionDeductAt !== 'acceptance' || order.commissionDeducted || !order.driverId) return;
    await this.deductCommission(tx, order, order.driverId, effects);
  }

  /** On COMPLETED: settle the order (unless already settled). Never called while DISPUTED. */
  async settle(tx: Tx, order: Order, effects: AfterCommit): Promise<void> {
    if (order.settledAt || !order.driverId) return;
    const driverId = order.driverId;
    if (order.paymentMethod === 'cod') {
      // Customer paid the driver cash; the platform's cut comes out of the driver's prepaid wallet.
      if (!order.commissionDeducted) await this.deductCommission(tx, order, driverId, effects);
    } else {
      const payment = await tx.payment.findFirst({
        where: { purpose: 'order', purposeId: order.id, direction: 'in', status: 'succeeded' },
        orderBy: { createdAt: 'desc' },
      });
      const fee = payment?.feeToea ?? 0;
      const bearer = payment?.feeBearer ?? 'platform';
      const commissionPart = order.commissionDeducted ? 0 : order.commissionToea;
      const driverFee = bearer === 'driver' ? fee : 0;
      const earning = order.priceToea - commissionPart - driverFee;
      const [driverWallet, platformWallet] = await Promise.all([this.ledger.driverWallet(driverId, tx), this.ledger.platformWallet(tx)]);
      const ref = { referenceType: 'order', referenceId: order.id, createdBy: 'system' };
      if (earning !== 0) {
        await this.ledger.post(tx, {
          ...ref,
          walletId: driverWallet.id,
          amountToea: earning,
          type: 'order_earning',
          idempotencyKey: `earning:${order.id}:${driverId}`,
          description: `Earnings for ${order.shortCode}`,
        });
      }
      if (commissionPart > 0) {
        await this.ledger.post(tx, {
          ...ref,
          walletId: platformWallet.id,
          amountToea: commissionPart,
          type: 'commission',
          idempotencyKey: `commission:${order.id}:${driverId}:credit`,
          description: `Commission ${order.shortCode}`,
        });
      }
      if (bearer === 'platform' && fee > 0) {
        await this.ledger.post(tx, {
          ...ref,
          walletId: platformWallet.id,
          amountToea: -fee,
          type: 'adjustment',
          idempotencyKey: `fee:${order.id}`,
          description: `Cell money fee ${order.shortCode}`,
        });
      }
      const after = await tx.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
      effects.add(() => this.walletChanged(driverId, after.balanceToea));
      if (earning > 0) {
        effects.add(async () => {
          const d = await this.prisma.driver.findUnique({ where: { id: driverId } });
          if (d) await this.notifications.notify(d.userId, 'driver.earning', { amount: formatKina(earning), shortCode: order.shortCode });
        });
      }
    }
    if (order.discountToea > 0) await this.absorbDiscount(tx, order, driverId, effects);
    await tx.order.update({ where: { id: order.id }, data: { settledAt: new Date(), commissionDeducted: true } });
    await this.referrals.rewardIfFirstOrder(tx, order, effects);
  }

  /**
   * Promo discounts come out of the platform's revenue. Cash orders: the driver collected the discounted
   * price, so the platform tops the driver up by the discount. Other methods: the driver's earning is
   * already based on the full price; the platform just records the cost.
   */
  private async absorbDiscount(tx: Tx, order: Order, driverId: string, effects: AfterCommit): Promise<void> {
    const platformWallet = await this.ledger.platformWallet(tx);
    const ref = { referenceType: 'order', referenceId: order.id, createdBy: 'system', description: `Promo discount ${order.shortCode}` };
    if (order.paymentMethod === 'cod') {
      const driverWallet = await this.ledger.driverWallet(driverId, tx);
      await this.ledger.transfer(tx, { walletId: platformWallet.id, type: 'promo' }, { walletId: driverWallet.id, type: 'promo' }, order.discountToea, {
        ...ref,
        idempotencyKey: `promo:${order.id}`,
      });
      const after = await tx.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
      effects.add(() => this.walletChanged(driverId, after.balanceToea));
    } else {
      await this.ledger.post(tx, { ...ref, walletId: platformWallet.id, amountToea: -order.discountToea, type: 'promo', idempotencyKey: `promo:${order.id}` });
    }
  }

  /** Give commission back to a driver when an accepted order is cancelled or reassigned before settlement. */
  async reverseCommission(tx: Tx, order: Order, effects: AfterCommit): Promise<void> {
    if (!order.commissionDeducted || order.settledAt || !order.driverId) return;
    const driverId = order.driverId;
    const [driverWallet, platformWallet] = await Promise.all([this.ledger.driverWallet(driverId, tx), this.ledger.platformWallet(tx)]);
    await this.ledger.transfer(
      tx,
      { walletId: platformWallet.id, type: 'commission' },
      { walletId: driverWallet.id, type: 'commission' },
      order.commissionToea,
      {
        referenceType: 'order',
        referenceId: order.id,
        idempotencyKey: `commission-reversal:${order.id}:${driverId}:${acceptanceKey(order)}`,
        createdBy: 'system',
        description: `Commission returned, ${order.shortCode} not completed`,
      },
    );
    await tx.order.update({ where: { id: order.id }, data: { commissionDeducted: false } });
    const after = await tx.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
    effects.add(() => this.walletChanged(driverId, after.balanceToea));
  }

  private async deductCommission(tx: Tx, order: Order, driverId: string, effects: AfterCommit): Promise<void> {
    if (order.commissionToea > 0) {
      const [driverWallet, platformWallet] = await Promise.all([this.ledger.driverWallet(driverId, tx), this.ledger.platformWallet(tx)]);
      await this.ledger.transfer(
        tx,
        { walletId: driverWallet.id, type: 'commission' },
        { walletId: platformWallet.id, type: 'commission' },
        order.commissionToea,
        {
          referenceType: 'order',
          referenceId: order.id,
          idempotencyKey: `commission:${order.id}:${driverId}:${acceptanceKey(order)}`,
          createdBy: 'system',
          description: `Commission ${order.shortCode}`,
        },
      );
      const after = await tx.wallet.findUniqueOrThrow({ where: { id: driverWallet.id } });
      effects.add(() => this.walletChanged(driverId, after.balanceToea));
    }
    await tx.order.update({ where: { id: order.id }, data: { commissionDeducted: true } });
  }

  /** Push the new balance; warn when it dropped below the minimum (driver is blocked until top-up, §8.2). */
  private async walletChanged(driverId: string, balanceToea: number): Promise<void> {
    const min = await this.settings.get('wallet.min_balance_toea');
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) return;
    this.realtime.toUser(driver.userId, 'wallet.updated', { balanceToea, minBalanceToea: min, blocked: balanceToea < min });
    if (balanceToea < min) {
      await this.notifications.notify(driver.userId, 'driver.low_balance', { balance: formatKina(balanceToea), minimum: formatKina(min) });
    }
  }
}

/** Distinguishes repeat acceptances of one order (admin reassigns) so each charge/reversal pair is unique. */
function acceptanceKey(order: Order): number {
  return order.acceptedAt?.getTime() ?? 0;
}
