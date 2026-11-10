import { Injectable } from '@nestjs/common';
import { LedgerEntry, LedgerType, Prisma, Wallet, WalletOwnerType } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { assertToea } from '../common/money';

/** Fixed owner id for the single platform wallet. */
export const PLATFORM_OWNER_ID = '00000000-0000-0000-0000-000000000000';

export interface PostEntry {
  walletId: string;
  amountToea: number;
  type: LedgerType;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  createdBy: string;
  description?: string;
}

/**
 * Double-entry-style ledger (§8.1). Entries are append-only (enforced by a DB trigger); the wallet's
 * cached balance is updated in the same transaction under a row lock. Re-posting an existing
 * idempotency key is a no-op that returns the original entry, so webhooks/retries never double-credit.
 */
@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  async post(tx: Tx, e: PostEntry): Promise<{ entry: LedgerEntry; created: boolean }> {
    assertToea(e.amountToea, 'amountToea');
    if (e.amountToea === 0) throw new Error('Ledger entries must be non-zero');
    // Lock the wallet first so concurrent posts with the same key serialise, then check the key.
    const wallet = await this.lockWallet(tx, e.walletId);
    const existing = await tx.ledgerEntry.findUnique({ where: { idempotencyKey: e.idempotencyKey } });
    if (existing) return { entry: existing, created: false };
    const balanceAfter = wallet.balanceToea + e.amountToea;
    const entry = await tx.ledgerEntry.create({
      data: {
        walletId: e.walletId,
        amountToea: e.amountToea,
        balanceAfter,
        type: e.type,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        idempotencyKey: e.idempotencyKey,
        createdBy: e.createdBy,
        description: e.description,
      },
    });
    await tx.wallet.update({ where: { id: e.walletId }, data: { balanceToea: balanceAfter } });
    return { entry, created: true };
  }

  /** Move money between two wallets atomically (both entries share a reference). */
  async transfer(
    tx: Tx,
    from: { walletId: string; type: LedgerType },
    to: { walletId: string; type: LedgerType },
    amountToea: number,
    ref: { referenceType: string; referenceId: string; idempotencyKey: string; createdBy: string; description?: string },
  ): Promise<boolean> {
    if (amountToea <= 0) return false;
    // Lock in a stable order to avoid deadlocks between opposite transfers.
    const [a, b] = [from.walletId, to.walletId].sort();
    await this.lockWallet(tx, a);
    await this.lockWallet(tx, b);
    const out = await this.post(tx, { ...ref, walletId: from.walletId, type: from.type, amountToea: -amountToea, idempotencyKey: `${ref.idempotencyKey}:debit` });
    await this.post(tx, { ...ref, walletId: to.walletId, type: to.type, amountToea, idempotencyKey: `${ref.idempotencyKey}:credit` });
    return out.created;
  }

  async lockWallet(tx: Tx, walletId: string): Promise<Wallet> {
    const rows = await tx.$queryRaw<{ id: string; balance_toea: number }[]>(
      Prisma.sql`SELECT id, balance_toea FROM wallets WHERE id = ${walletId}::uuid FOR UPDATE`,
    );
    if (!rows[0]) throw new Error(`Wallet ${walletId} not found`);
    return tx.wallet.findUniqueOrThrow({ where: { id: walletId } });
  }

  async walletFor(ownerType: WalletOwnerType, ownerId: string, db: Tx | PrismaService = this.prisma): Promise<Wallet> {
    return db.wallet.upsert({
      where: { ownerType_ownerId: { ownerType, ownerId } },
      create: { ownerType, ownerId },
      update: {},
    });
  }

  driverWallet(driverId: string, db: Tx | PrismaService = this.prisma): Promise<Wallet> {
    return this.walletFor('driver', driverId, db);
  }

  /** Customer wallet (StarTrip-style "cash"): top-ups, referral/promo credits, refunds, pays orders. */
  customerWallet(userId: string, db: Tx | PrismaService = this.prisma): Promise<Wallet> {
    return this.walletFor('customer', userId, db);
  }

  platformWallet(db: Tx | PrismaService = this.prisma): Promise<Wallet> {
    return this.walletFor('platform', PLATFORM_OWNER_ID, db);
  }

  /** Recompute a balance from entries (reconciliation / tests). */
  async ledgerSum(walletId: string): Promise<number> {
    const r = await this.prisma.ledgerEntry.aggregate({ where: { walletId }, _sum: { amountToea: true } });
    return r._sum.amountToea ?? 0;
  }
}
