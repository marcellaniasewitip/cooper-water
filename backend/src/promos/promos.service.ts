import { Injectable } from '@nestjs/common';
import { PromoCode } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { formatKina } from '../common/money';

export interface PromoInput {
  code: string;
  description?: string;
  discountType: 'percent' | 'flat';
  discountValue: number;
  maxDiscountToea?: number | null;
  minOrderToea?: number;
  startsAt?: string | null;
  expiresAt?: string | null;
  maxUses?: number | null;
  perCustomerLimit?: number;
  public?: boolean;
  active?: boolean;
}

export const normalisePromoCode = (code: string) => code.trim().toUpperCase().replace(/\s+/g, '');

/** Discount for a price: percent (capped) or flat, never more than the price itself. */
export function promoDiscount(p: Pick<PromoCode, 'discountType' | 'discountValue' | 'maxDiscountToea'>, priceToea: number): number {
  const raw = p.discountType === 'percent' ? Math.floor((priceToea * p.discountValue) / 100) : p.discountValue;
  const capped = p.maxDiscountToea != null ? Math.min(raw, p.maxDiscountToea) : raw;
  return Math.max(0, Math.min(capped, priceToea));
}

/**
 * Offers / promo codes. Cooper Waters absorbs the discount: the customer pays price − discount and the
 * driver's earnings are unchanged (settlement credits a COD driver the discount from the platform wallet).
 */
@Injectable()
export class PromosService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Validate a code for this customer and price. Pass `tx` to lock the code row while redeeming so
   * concurrent orders can't exceed its limits.
   */
  async evaluate(codeInput: string, customerId: string, priceToea: number, tx?: Tx): Promise<{ promo: PromoCode; discountToea: number }> {
    const db = tx ?? this.prisma;
    const code = normalisePromoCode(codeInput);
    if (tx) await tx.$queryRaw`SELECT id FROM promo_codes WHERE code = ${code} FOR UPDATE`;
    const promo = await db.promoCode.findUnique({ where: { code } });
    if (!promo || !promo.active) {
      // People often type a friend's Refer & Earn code (CW + 6 characters) here. Say so, so the app can apply
      // it as a referral instead of showing a dead "not valid".
      if (!promo && (await db.user.findFirst({ where: { referralCode: code }, select: { id: true } }))) {
        throw Errors.invalid('promo_is_referral', 'This is a Refer & Earn code, not a promo code');
      }
      throw Errors.invalid('promo_not_found', 'This promo code is not valid');
    }
    const now = new Date();
    if (promo.startsAt && promo.startsAt > now) throw Errors.invalid('promo_not_started', 'This promo code is not active yet');
    if (promo.expiresAt && promo.expiresAt <= now) throw Errors.invalid('promo_expired', 'This promo code has expired');
    if (priceToea < promo.minOrderToea) {
      throw Errors.invalid('promo_min_order', `This code needs an order of at least ${formatKina(promo.minOrderToea)}`);
    }
    const [used, usedByCustomer] = await Promise.all([
      promo.maxUses != null ? db.promoRedemption.count({ where: { promoCodeId: promo.id } }) : Promise.resolve(0),
      db.promoRedemption.count({ where: { promoCodeId: promo.id, customerId } }),
    ]);
    if (promo.maxUses != null && used >= promo.maxUses) throw Errors.invalid('promo_used_up', 'This promo code has been fully used');
    if (usedByCustomer >= promo.perCustomerLimit) throw Errors.invalid('promo_already_used', 'You have already used this promo code');
    return { promo, discountToea: promoDiscount(promo, priceToea) };
  }

  /** Offers screen "ADD": check a typed code (ignoring the minimum order, which is checked at checkout). */
  async describe(codeInput: string, customerId: string) {
    const { promo } = await this.evaluate(codeInput, customerId, Number.MAX_SAFE_INTEGER);
    return {
      code: promo.code,
      description: promo.description,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      maxDiscountToea: promo.maxDiscountToea,
      minOrderToea: promo.minOrderToea,
      expiresAt: promo.expiresAt,
      usable: true,
    };
  }

  async redeem(tx: Tx, promoId: string, customerId: string, orderId: string, discountToea: number): Promise<void> {
    await tx.promoRedemption.create({ data: { promoCodeId: promoId, customerId, orderId, discountToea } });
  }

  /** An order that never completed gives the customer their use back. */
  async release(tx: Tx, orderId: string): Promise<void> {
    await tx.promoRedemption.deleteMany({ where: { orderId } });
  }

  /** Offers screen: public codes that are live now, with whether this customer can still use them. */
  async offersFor(customerId: string) {
    const now = new Date();
    const rows = await this.prisma.promoCode.findMany({
      where: {
        active: true,
        public: true,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { redemptions: true } } },
    });
    const mine = await this.prisma.promoRedemption.groupBy({ by: ['promoCodeId'], where: { customerId }, _count: true });
    const usedByMe = new Map(mine.map((m) => [m.promoCodeId, m._count]));
    return rows
      .filter((p) => p.maxUses == null || p._count.redemptions < p.maxUses)
      .map((p) => ({
        code: p.code,
        description: p.description,
        discountType: p.discountType,
        discountValue: p.discountValue,
        maxDiscountToea: p.maxDiscountToea,
        minOrderToea: p.minOrderToea,
        expiresAt: p.expiresAt,
        usable: (usedByMe.get(p.id) ?? 0) < p.perCustomerLimit,
      }));
  }

  // ───────────── Admin ─────────────

  async list() {
    const rows = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { redemptions: true } } } });
    return rows.map(({ _count, ...p }) => ({ ...p, uses: _count.redemptions }));
  }

  async create(adminId: string, input: PromoInput, ip: string | null) {
    const data = this.toData(input);
    const exists = await this.prisma.promoCode.findUnique({ where: { code: data.code } });
    if (exists) throw Errors.conflict('promo_code_exists', 'A promo code with this code already exists');
    const promo = await this.prisma.promoCode.create({ data });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'promo.create', entity: 'promo_code', entityId: promo.id, after: promo, ip });
    return promo;
  }

  async update(adminId: string, id: string, input: Partial<PromoInput>, ip: string | null) {
    const before = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Promo code');
    const merged = this.toData({ ...this.fromRow(before), ...input, code: before.code });
    const after = await this.prisma.promoCode.update({ where: { id }, data: merged });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'promo.update', entity: 'promo_code', entityId: id, before, after, ip });
    return after;
  }

  private toData(i: PromoInput) {
    const code = normalisePromoCode(i.code);
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw Errors.invalid('promo_code_format', 'Codes are 3–30 letters, digits, - or _');
    if (i.discountType === 'percent' && (i.discountValue < 1 || i.discountValue > 100)) {
      throw Errors.invalid('promo_percent_range', 'A percent discount must be between 1 and 100');
    }
    if (i.discountType === 'flat' && i.discountValue < 1) throw Errors.invalid('promo_flat_positive', 'A fixed discount must be at least 1 toea');
    const startsAt = i.startsAt ? new Date(i.startsAt) : null;
    const expiresAt = i.expiresAt ? new Date(i.expiresAt) : null;
    if (startsAt && expiresAt && expiresAt <= startsAt) throw Errors.invalid('promo_dates', 'The expiry must be after the start');
    return {
      code,
      description: i.description ?? '',
      discountType: i.discountType,
      discountValue: i.discountValue,
      maxDiscountToea: i.maxDiscountToea ?? null,
      minOrderToea: i.minOrderToea ?? 0,
      startsAt,
      expiresAt,
      maxUses: i.maxUses ?? null,
      perCustomerLimit: i.perCustomerLimit ?? 1,
      public: i.public ?? true,
      active: i.active ?? true,
    };
  }

  private fromRow(p: PromoCode): PromoInput {
    return {
      code: p.code,
      description: p.description,
      discountType: p.discountType,
      discountValue: p.discountValue,
      maxDiscountToea: p.maxDiscountToea,
      minOrderToea: p.minOrderToea,
      startsAt: p.startsAt?.toISOString() ?? null,
      expiresAt: p.expiresAt?.toISOString() ?? null,
      maxUses: p.maxUses,
      perCustomerLimit: p.perCustomerLimit,
      public: p.public,
      active: p.active,
    };
  }
}
