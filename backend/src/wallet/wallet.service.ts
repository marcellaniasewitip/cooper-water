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
    const pendingPayouts = await this.undeductedPayouts(driverId);
    const pendingPayoutsToea = pendingPayouts.reduce((s, p) => s + p.amountToea, 0);
    return {
      walletId: wallet.id,
      balanceToea: wallet.balanceToea,
      minBalanceToea: min,
      blocked: wallet.balanceToea < min,
      /** Needed to reach the minimum and take jobs again. */
      shortfallToea: Math.max(0, min - wallet.balanceToea),
      /** Balance above the minimum, less withdrawals already requested but not yet deducted. */
      withdrawableToea: Math.max(0, wallet.balanceToea - min - pendingPayoutsToea),
      payoutMinToea: payoutMin,
      pendingTopups: { count: pendingTopups._count, amountToea: pendingTopups._sum.amountToea ?? 0 },
      /** Withdrawals waiting for Cooper Waters (not yet deducted from the balance). */
      pendingPayouts: { count: pendingPayouts.length, amountToea: pendingPayoutsToea },
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

  /**
   * Withdrawals that still count against the balance: requested, approved or paid, and not yet deducted
   * from the wallet. The deduction is a ledger entry with key `payout:<id>`, posted by an admin from the
   * driver's wallet (older withdrawals were deducted automatically at request time, with the same key).
   */
  async undeductedPayouts(driverId: string, db: Tx | PrismaService = this.prisma) {
    const open = await db.payout.findMany({ where: { driverId, status: { in: ['requested', 'approved', 'paid'] } }, select: { id: true, amountToea: true, status: true } });
    if (open.length === 0) return [];
    const deducted = await this.deductedPayoutIds(open.map((p) => p.id), db);
    return open.filter((p) => !deducted.has(p.id));
  }

  /** Which of these payouts have been deducted from the driver's wallet. */
  async deductedPayoutIds(ids: string[], db: Tx | PrismaService = this.prisma): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db.ledgerEntry.findMany({ where: { idempotencyKey: { in: ids.map((id) => `payout:${id}`) } }, select: { idempotencyKey: true } });
    return new Set(rows.map((r) => r.idempotencyKey.slice('payout:'.length)));
  }

  /**
   * Withdrawal request. Nothing is deducted now: the request waits in the admin payout queue, and an admin
   * deducts it manually from the driver's wallet when paying. The amount must fit in the balance above the
   * minimum, less other withdrawals still waiting to be deducted.
   */
  async requestPayout(driverId: string, dto: { amountToea: number; method: string; destination: string }, idempotencyKey: string) {
    const existing = await this.prisma.payout.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    const [min, payoutMin] = await Promise.all([this.settings.get('wallet.min_balance_toea'), this.settings.get('payout.min_toea')]);
    if (dto.amountToea < payoutMin) throw Errors.invalid('payout_too_small', `The minimum withdrawal is ${formatKina(payoutMin)}`);
    const payout = await this.prisma.tx(async (tx) => {
      const wallet = await this.ledger.driverWallet(driverId, tx);
      // Lock the wallet so two requests at once can't both pass the check.
      const locked = await this.ledger.lockWallet(tx, wallet.id);
      const pending = (await this.undeductedPayouts(driverId, tx)).reduce((s, p) => s + p.amountToea, 0);
      const available = locked.balanceToea - min - pending;
      if (dto.amountToea > available) {
        const why = pending > 0 ? ` (your balance above the ${formatKina(min)} minimum, less ${formatKina(pending)} already requested)` : ` (your balance above the ${formatKina(min)} minimum)`;
        throw Errors.invalid('insufficient_balance', `You can withdraw up to ${formatKina(Math.max(0, available))}${why}`);
      }
      return tx.payout.create({
        data: { driverId, amountToea: dto.amountToea, method: dto.method, destination: dto.destination, idempotencyKey },
      });
    });
    this.realtime.toAdmins('payout.requested', { payoutId: payout.id, driverId, amountToea: payout.amountToea });
    return payout;
  }

  async listPayouts(where: Prisma.PayoutWhereInput, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.payout.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { driver: { include: { user: { select: { name: true, phone: true } } } } },
    });
    const page = toPage(rows, limit);
    const deducted = await this.deductedPayoutIds(page.items.map((p) => p.id));
    const wallets = await this.prisma.wallet.findMany({
      where: { ownerType: 'driver', ownerId: { in: [...new Set(page.items.map((p) => p.driverId))] } },
      select: { id: true, ownerId: true, balanceToea: true },
    });
    return {
      items: page.items.map((p) => {
        const w = wallets.find((x) => x.ownerId === p.driverId);
        return { ...p, deducted: deducted.has(p.id), walletId: w?.id ?? null, walletBalanceToea: w?.balanceToea ?? null };
      }),
      nextCursor: page.nextCursor,
    };
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
      // Only give money back if it was actually taken out (older requests, or deducted before rejecting).
      if (action === 'reject' && (await this.deductedPayoutIds([p.id], tx)).has(p.id)) {
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

  async adjust(adminId: string, walletId: string, amountToea: number, reason: string, idempotencyKey: string, ip: string | null, payoutId?: string) {
    const entry = payoutId ? await this.deductPayout(adminId, walletId, payoutId, amountToea, reason, ip) : await this.postAdjustment(adminId, walletId, amountToea, reason, idempotencyKey, ip);
    await this.afterAdjust(walletId, entry.amountToea, reason, entry.createdAt);
    return entry;
  }

  /** Tell the customer or driver: live balance update in the app plus a notification (top-up or deduction). */
  private async afterAdjust(walletId: string, amountToea: number, reason: string, at: Date) {
    // Only for a fresh entry (an idempotent replay returns an older one).
    if (Date.now() - at.getTime() > 60_000) return;
    const w = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!w) return;
    let userId: string | null = null;
    let payload: Record<string, unknown> = { balanceToea: w.balanceToea };
    if (w.ownerType === 'customer') {
      userId = w.ownerId;
    } else if (w.ownerType === 'driver') {
      const driver = await this.prisma.driver.findUnique({ where: { id: w.ownerId } });
      const min = await this.settings.get('wallet.min_balance_toea');
      userId = driver?.userId ?? null;
      payload = { balanceToea: w.balanceToea, minBalanceToea: min, blocked: w.balanceToea < min };
    }
    if (!userId) return;
    this.realtime.toUser(userId, 'wallet.updated', payload);
    await this.notifications.notify(userId, 'wallet.adjusted', {
      amount: formatKina(Math.abs(amountToea)),
      direction: amountToea >= 0 ? 'was added to' : 'was deducted from',
      reason,
      balance: formatKina(w.balanceToea),
    });
  }

  private async postAdjustment(adminId: string, walletId: string, amountToea: number, reason: string, idempotencyKey: string, ip: string | null) {
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

  /**
   * Manual deduction of a withdrawal from the driver's wallet (admin → driver → Wallet, "Deduct" on the
   * payout). Linked to the payout with key `payout:<id>`, so the same withdrawal can never be deducted twice.
   */
  private async deductPayout(adminId: string, walletId: string, payoutId: string, amountToea: number, reason: string, ip: string | null) {
    return this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payouts WHERE id = ${payoutId}::uuid FOR UPDATE`;
      const p = await tx.payout.findUnique({ where: { id: payoutId } });
      if (!p) throw Errors.notFound('Withdrawal');
      const wallet = await this.ledger.driverWallet(p.driverId, tx);
      if (wallet.id !== walletId) throw Errors.invalid('payout_wallet_mismatch', 'This withdrawal belongs to another driver');
      if (p.status === 'rejected') throw Errors.conflict('payout_state', 'This withdrawal was rejected, so there is nothing to deduct');
      if (amountToea !== -p.amountToea) throw Errors.invalid('payout_amount_mismatch', `Deduct exactly ${formatKina(p.amountToea)} for this withdrawal`);
      const { entry, created } = await this.ledger.post(tx, {
        walletId,
        amountToea: -p.amountToea,
        type: 'payout',
        referenceType: 'payout',
        referenceId: p.id,
        idempotencyKey: `payout:${p.id}`,
        createdBy: `admin:${adminId}`,
        description: reason,
      });
      if (!created) throw Errors.conflict('payout_already_deducted', 'This withdrawal has already been deducted from the wallet');
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'payout.deduct', entity: 'payout', entityId: p.id, after: entry, ip }, tx);
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
