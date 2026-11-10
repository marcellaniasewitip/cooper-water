import { Injectable } from '@nestjs/common';
import { Prisma, TopupRequest } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { LedgerService } from './ledger.service';
import { AfterCommit } from '../common/after-commit';
import { Errors } from '../common/errors';
import { formatKina } from '../common/money';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  // ───────────── Driver views ─────────────

  async summary(driverId: string) {
    const [wallet, min, payoutMin] = await Promise.all([
      this.ledger.driverWallet(driverId),
      this.settings.get('wallet.min_balance_toea'),
      this.settings.get('payout.min_toea'),
    ]);
    const pendingTopups = await this.prisma.topupRequest.aggregate({
      where: { driverId, status: 'pending' },
      _sum: { amountToea: true },
      _count: true,
    });
    return {
      walletId: wallet.id,
      balanceToea: wallet.balanceToea,
      minBalanceToea: min,
      blocked: wallet.balanceToea < min,
      /** Needed to reach the minimum and take jobs again. */
      shortfallToea: Math.max(0, min - wallet.balanceToea),
      withdrawableToea: Math.max(0, wallet.balanceToea - min),
      payoutMinToea: payoutMin,
      pendingTopups: { count: pendingTopups._count, amountToea: pendingTopups._sum.amountToea ?? 0 },
    };
  }

  async entries(walletId: string, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.ledgerEntry.findMany({
      where: { AND: [{ walletId }, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  async earningsSummary(driverId: string, since: Date) {
    const wallet = await this.ledger.driverWallet(driverId);
    const groups = await this.prisma.ledgerEntry.groupBy({
      by: ['type'],
      where: { walletId: wallet.id, createdAt: { gte: since } },
      _sum: { amountToea: true },
    });
    const sum = (t: string) => groups.find((g) => g.type === t)?._sum.amountToea ?? 0;
    const completed = await this.prisma.order.findMany({
      where: { driverId, status: 'COMPLETED', completedAt: { gte: since } },
      select: { priceToea: true, commissionToea: true, paymentMethod: true },
    });
    const gross = completed.reduce((a, o) => a + o.priceToea, 0);
    const commission = completed.reduce((a, o) => a + o.commissionToea, 0);
    const cash = completed.filter((o) => o.paymentMethod === 'cod').reduce((a, o) => a + o.priceToea, 0);
    return {
      since,
      completedOrders: completed.length,
      grossToea: gross,
      commissionToea: commission,
      netToea: gross - commission,
      cashCollectedToea: cash,
      cellmoneyEarningsCreditedToea: sum('order_earning'),
      topupsToea: sum('topup'),
      payoutsToea: -sum('payout'),
    };
  }

  // ───────────── Customer wallet ─────────────

  async customerSummary(userId: string) {
    const wallet = await this.ledger.customerWallet(userId);
    const pending = await this.prisma.topupRequest.aggregate({
      where: { customerId: userId, status: 'pending' },
      _sum: { amountToea: true },
      _count: true,
    });
    return {
      walletId: wallet.id,
      balanceToea: wallet.balanceToea,
      pendingTopups: { count: pending._count, amountToea: pending._sum.amountToea ?? 0 },
    };
  }

  /** Customer top-up by cash, bank transfer or cell money; an admin approves it in Wallet top-ups (same as drivers). */
  async submitCustomerTopup(
    userId: string,
    dto: { method: 'cash' | 'bank_transfer' | 'cellmoney'; amountToea: number; referenceText: string; msisdn?: string; proofFileKey?: string },
    idempotencyKey: string,
  ) {
    if (dto.proofFileKey) this.storage.assertOwnedKey(dto.proofFileKey, 'topup-proofs', userId);
    const existing = await this.prisma.topupRequest.findUnique({ where: { idempotencyKey } });
    if (existing) {
      if (existing.customerId !== userId) throw Errors.conflict('idempotency_key_reused', 'This request key was already used');
      return existing;
    }
    return this.prisma.topupRequest.create({
      data: {
        customerId: userId,
        method: dto.method,
        amountToea: dto.amountToea,
        referenceText: dto.referenceText,
        msisdn: dto.msisdn,
        proofFileKey: dto.proofFileKey,
        idempotencyKey,
      },
    });
  }

  async customerTopups(userId: string, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.topupRequest.findMany({
      where: { AND: [{ customerId: userId }, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
    });
    return toPage(rows, limit);
  }

  // ───────────── Top-ups (§8.5) ─────────────

  async submitBankTopup(
    driverId: string,
    dto: { amountToea: number; referenceText: string; proofFileKey?: string; method?: 'bank_transfer' | 'cash' },
    idempotencyKey: string,
  ) {
    if (dto.proofFileKey) this.storage.assertOwnedKey(dto.proofFileKey, 'topup-proofs', driverId);
    const existing = await this.prisma.topupRequest.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    return this.prisma.topupRequest.create({
      data: {
        driverId,
        method: dto.method ?? 'bank_transfer',
        amountToea: dto.amountToea,
        referenceText: dto.referenceText,
        proofFileKey: dto.proofFileKey,
        idempotencyKey,
      },
    });
  }

  async listTopups(where: Prisma.TopupRequestWhereInput, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.topupRequest.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { driver: { include: { user: { select: { name: true, phone: true } } } }, customer: { select: { id: true, name: true, phone: true } }, payment: true },
    });
    const page = toPage(rows, limit);
    const items = await Promise.all(
      page.items.map(async (t) => ({ ...t, proofUrl: t.proofFileKey ? await this.storage.presignDownload(t.proofFileKey).catch(() => null) : null })),
    );
    return { items, nextCursor: page.nextCursor };
  }

  /** Credit a top-up. Called by admin approval and by successful cell money collections. Idempotent. */
  async creditTopup(tx: Tx, topup: TopupRequest, createdBy: string, effects: AfterCommit, reviewerId: string | null = null): Promise<void> {
    const wallet = topup.customerId
      ? await this.ledger.customerWallet(topup.customerId, tx)
      : await this.ledger.driverWallet(topup.driverId!, tx);
    await this.ledger.post(tx, {
      walletId: wallet.id,
      amountToea: topup.amountToea,
      type: 'topup',
      referenceType: 'topup',
      referenceId: topup.id,
      idempotencyKey: `topup:${topup.id}`,
      createdBy,
      description: topupDescription(topup),
    });
    await tx.topupRequest.update({
      where: { id: topup.id },
      data: { status: 'approved', reviewedBy: reviewerId, reviewedAt: new Date() },
    });
    const after = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
    effects.add(async () => {
      if (topup.customerId) {
        this.realtime.toUser(topup.customerId, 'wallet.updated', { balanceToea: after.balanceToea });
        await this.notifications.notify(topup.customerId, 'topup.approved', { amount: formatKina(topup.amountToea), balance: formatKina(after.balanceToea) });
        return;
      }
      const driver = await this.prisma.driver.findUnique({ where: { id: topup.driverId! } });
      if (!driver) return;
      const min = await this.settings.get('wallet.min_balance_toea');
      this.realtime.toUser(driver.userId, 'wallet.updated', { balanceToea: after.balanceToea, minBalanceToea: min, blocked: after.balanceToea < min });
      await this.notifications.notify(driver.userId, 'topup.approved', { amount: formatKina(topup.amountToea), balance: formatKina(after.balanceToea) });
    });
  }

  async approveTopup(adminId: string, topupId: string, ip: string | null) {
    const effects = new AfterCommit();
    const result = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM topup_requests WHERE id = ${topupId}::uuid FOR UPDATE`;
      const t = await tx.topupRequest.findUnique({ where: { id: topupId } });
      if (!t) throw Errors.notFound('Top-up');
      if (t.status !== 'pending') throw Errors.conflict('topup_not_pending', `This top-up is already ${t.status}`);
      if (t.paymentId) {
        // Manual cell money top-up matched by an admin: the collection succeeded.
        await tx.payment.update({ where: { id: t.paymentId }, data: { status: 'succeeded', settledAt: new Date() } });
      }
      await this.creditTopup(tx, t, `admin:${adminId}`, effects, adminId);
      const after = await tx.topupRequest.findUniqueOrThrow({ where: { id: t.id } });
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'topup.approve', entity: 'topup_request', entityId: t.id, before: t, after, ip }, tx);
      return after;
    });
    await effects.run();
    return result;
  }

  async rejectTopup(adminId: string, topupId: string, reason: string, ip: string | null) {
    const result = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM topup_requests WHERE id = ${topupId}::uuid FOR UPDATE`;
      const t = await tx.topupRequest.findUnique({ where: { id: topupId } });
      if (!t) throw Errors.notFound('Top-up');
      if (t.status !== 'pending') throw Errors.conflict('topup_not_pending', `This top-up is already ${t.status}`);
      const after = await tx.topupRequest.update({
        where: { id: t.id },
        data: { status: 'rejected', rejectReason: reason, reviewedBy: adminId, reviewedAt: new Date() },
      });
      if (t.paymentId) await tx.payment.update({ where: { id: t.paymentId }, data: { status: 'failed', failureReason: reason } });
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'topup.reject', entity: 'topup_request', entityId: t.id, before: t, after, ip }, tx);
      return after;
    });
    const userId = result.customerId ?? (result.driverId ? (await this.prisma.driver.findUnique({ where: { id: result.driverId } }))?.userId : null);
    if (userId) await this.notifications.notify(userId, 'topup.rejected', { amount: formatKina(result.amountToea), reason });
    return result;
  }

  // ───────────── Payouts (§8.3, manual in MVP) ─────────────

  /** Withdrawal of balance above the minimum. Funds are reserved (payout entry) at request time. */
  async requestPayout(driverId: string, dto: { amountToea: number; method: string; destination: string }, idempotencyKey: string) {
    const existing = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    const [min, payoutMin] = await Promise.all([this.settings.get('wallet.min_balance_toea'), this.settings.get('payout.min_toea')]);
    if (dto.amountToea < payoutMin) throw Errors.invalid('payout_too_small', `The minimum withdrawal is ${formatKina(payoutMin)}`);
    return this.prisma.tx(async (tx) => {
      const wallet = await this.ledger.driverWallet(driverId, tx);
      const locked = await this.ledger.lockWallet(tx, wallet.id);
      const available = locked.balanceToea - min;
      if (dto.amountToea > available) {
        throw Errors.invalid('insufficient_balance', `You can withdraw up to ${formatKina(Math.max(0, available))} (your balance above the ${formatKina(min)} minimum)`);
      }
      const payout = await tx.payout.create({
        data: { driverId, amountToea: dto.amountToea, method: dto.method, destination: dto.destination, idempotencyKey },
      });
      await this.ledger.post(tx, {
        walletId: wallet.id,
        amountToea: -dto.amountToea,
        type: 'payout',
        referenceType: 'payout',
        referenceId: payout.id,
        idempotencyKey: `payout:${payout.id}`,
        createdBy: `driver:${driverId}`,
        description: `Withdrawal to ${dto.method}`,
      });
      return payout;
    });
  }

  async listPayouts(where: Prisma.PayoutWhereInput, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.payout.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { driver: { include: { user: { select: { name: true, phone: true } } } } },
    });
    return toPage(rows, limit);
  }

  async processPayout(adminId: string, payoutId: string, action: 'approve' | 'paid' | 'reject', body: { externalRef?: string; notes?: string }, ip: string | null) {
    const result = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payouts WHERE id = ${payoutId}::uuid FOR UPDATE`;
      const p = await tx.payout.findUnique({ where: { id: payoutId } });
      if (!p) throw Errors.notFound('Payout');
      const allowed: Record<string, string[]> = { approve: ['requested'], paid: ['requested', 'approved'], reject: ['requested', 'approved'] };
      if (!allowed[action].includes(p.status)) throw Errors.conflict('payout_state', `This withdrawal is already ${p.status}`);
      if (action === 'paid' && !body.externalRef) throw Errors.invalid('external_ref_required', 'Enter the bank or cell money transaction reference');
      const status = action === 'approve' ? 'approved' : action === 'paid' ? 'paid' : 'rejected';
      const after = await tx.payout.update({
        where: { id: p.id },
        data: { status, processedBy: adminId, processedAt: new Date(), externalRef: body.externalRef ?? p.externalRef, notes: body.notes ?? p.notes },
      });
      if (action === 'reject') {
        const wallet = await this.ledger.driverWallet(p.driverId, tx);
        await this.ledger.post(tx, {
          walletId: wallet.id,
          amountToea: p.amountToea,
          type: 'adjustment',
          referenceType: 'payout',
          referenceId: p.id,
          idempotencyKey: `payout-reversal:${p.id}`,
          createdBy: `admin:${adminId}`,
          description: 'Withdrawal rejected, funds returned',
        });
      }
      if (action === 'paid') {
        await tx.payment.create({
          data: {
            provider: p.method === 'cellmoney' ? 'cellmoney' : 'bank',
            adapter: 'manual',
            direction: 'out',
            amountToea: p.amountToea,
            status: 'succeeded',
            providerRef: `payout-${body.externalRef}-${p.id}`,
            reference: body.externalRef!,
            purpose: 'payout',
            purposeId: p.id,
            idempotencyKey: `payout-payment:${p.id}`,
            settledAt: new Date(),
          },
        });
      }
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: `payout.${action}`, entity: 'payout', entityId: p.id, before: p, after, ip }, tx);
      return after;
    });
    const driver = await this.prisma.driver.findUnique({ where: { id: result.driverId } });
    if (driver && action !== 'approve') {
      await this.notifications.notify(driver.userId, action === 'paid' ? 'payout.paid' : 'payout.rejected', {
        amount: formatKina(result.amountToea),
        reason: body.notes ?? '',
      });
    }
    return result;
  }

  // ───────────── Admin adjustments ─────────────

  async adjust(adminId: string, walletId: string, amountToea: number, reason: string, idempotencyKey: string, ip: string | null) {
    return this.prisma.tx(async (tx) => {
      const { entry, created } = await this.ledger.post(tx, {
        walletId,
        amountToea,
        type: 'adjustment',
        referenceType: 'admin_adjustment',
        referenceId: walletId,
        idempotencyKey: `adjust:${idempotencyKey}`,
        createdBy: `admin:${adminId}`,
        description: reason,
      });
      if (created) {
        await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'wallet.adjust', entity: 'wallet', entityId: walletId, after: entry, ip }, tx);
      }
      return entry;
    });
  }
}

function topupDescription(t: TopupRequest): string {
  switch (t.method) {
    case 'bank_transfer':
      return `Bank top-up ${t.referenceText}`.trim();
    case 'cash':
      return `Cash top-up ${t.referenceText}`.trim();
    default:
      return 'Cell money top-up';
  }
}
