import { Injectable } from '@nestjs/common';
import { Order } from '@prisma/client';
import { randomInt } from 'crypto';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LedgerService } from '../wallet/ledger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AfterCommit } from '../common/after-commit';
import { Errors } from '../common/errors';
import { formatKina } from '../common/money';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/**
 * Refer & Earn: each customer has a personal code. A new customer can enter a friend's code before
 * their first order; when that first order completes, both get wallet credit (setting referral.reward_toea),
 * paid from the platform wallet.
 */
@Injectable()
export class ReferralsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly ledger: LedgerService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async summary(userId: string) {
    const [code, reward, enabled, me, invited, rewarded] = await Promise.all([
      this.codeFor(userId),
      this.settings.get('referral.reward_toea'),
      this.settings.get('referral.enabled'),
      this.prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { referredBy: { select: { referralCode: true } } } }),
      this.prisma.user.count({ where: { referredById: userId } }),
      this.prisma.user.count({ where: { referredById: userId, referralRewardedAt: { not: null } } }),
    ]);
    const completedOrders = await this.prisma.order.count({ where: { customerId: userId, status: 'COMPLETED' } });
    return {
      enabled,
      code,
      rewardToea: reward,
      invitedCount: invited,
      rewardedCount: rewarded,
      earnedToea: rewarded * reward,
      referredByCode: me.referredBy?.referralCode ?? null,
      canApplyCode: !me.referredById && completedOrders === 0,
    };
  }

  /** Lazily give a customer a short unique code. */
  async codeFor(userId: string): Promise<string> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (u.referralCode) return u.referralCode;
    for (let i = 0; i < 8; i++) {
      const code = 'CW' + Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      const updated = await this.prisma.user.updateMany({ where: { id: userId, referralCode: null }, data: { referralCode: code } }).catch(() => null);
      if (updated) return (await this.prisma.user.findUniqueOrThrow({ where: { id: userId } })).referralCode!;
    }
    throw new Error('Could not allocate a referral code');
  }

  async apply(userId: string, codeInput: string) {
    if (!(await this.settings.get('referral.enabled'))) throw Errors.invalid('referral_disabled', 'Refer & Earn is not available right now');
    const code = codeInput.trim().toUpperCase();
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (me.referredById) throw Errors.conflict('referral_already_applied', 'You have already used a referral code');
    const orders = await this.prisma.order.count({ where: { customerId: userId, status: 'COMPLETED' } });
    if (orders > 0) throw Errors.invalid('referral_too_late', 'Referral codes can only be used before your first completed order');
    const referrer = await this.prisma.user.findUnique({ where: { referralCode: code } });
    if (!referrer || referrer.role !== 'customer') throw Errors.invalid('referral_not_found', 'This referral code is not valid');
    if (referrer.id === userId) throw Errors.invalid('referral_self', 'You cannot use your own code');
    await this.prisma.user.updateMany({ where: { id: userId, referredById: null }, data: { referredById: referrer.id } });
    return this.summary(userId);
  }

  /** Called when an order completes (inside its transaction). Pays both sides once, on the first completed order. */
  async rewardIfFirstOrder(tx: Tx, order: Order, effects: AfterCommit): Promise<void> {
    const customer = await tx.user.findUnique({ where: { id: order.customerId } });
    if (!customer?.referredById || customer.referralRewardedAt) return;
    if (!(await this.settings.get('referral.enabled'))) return;
    const reward = await this.settings.get('referral.reward_toea');
    if (reward <= 0) return;
    const claimed = await tx.user.updateMany({ where: { id: customer.id, referralRewardedAt: null }, data: { referralRewardedAt: new Date() } });
    if (claimed.count !== 1) return;
    const platform = await this.ledger.platformWallet(tx);
    for (const [userId, role] of [[customer.id, 'referee'], [customer.referredById, 'referrer']] as const) {
      const wallet = await this.ledger.customerWallet(userId, tx);
      await this.ledger.transfer(tx, { walletId: platform.id, type: 'referral' }, { walletId: wallet.id, type: 'referral' }, reward, {
        referenceType: 'referral',
        referenceId: customer.id,
        idempotencyKey: `referral:${customer.id}:${role}`,
        createdBy: 'system',
        description: role === 'referee' ? 'Welcome reward (referral)' : 'Referral reward',
      });
      const after = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      effects.add(async () => {
        this.realtime.toUser(userId, 'wallet.updated', { balanceToea: after.balanceToea });
        await this.notifications.notify(userId, 'referral.rewarded', { amount: formatKina(reward), balance: formatKina(after.balanceToea) });
      });
    }
  }
}
