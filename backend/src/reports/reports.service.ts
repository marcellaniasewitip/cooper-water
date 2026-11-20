import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { LedgerService } from '../wallet/ledger.service';
import { BUSINESS_UTC_OFFSET_HOURS, formatLocal, startOfBusinessDay } from '../common/time';
import { Errors } from '../common/errors';

export interface ReportRange {
  from: Date;
  to: Date;
}

/** Reports (§10, §12). Days are Port Moresby local days (UTC+10). */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly ledger: LedgerService,
  ) {}

  async overview() {
    const today = startOfBusinessDay();
    const staleSec = await this.settings.get('driver.location_stale_sec');
    const platform = await this.ledger.platformWallet();
    const [byStatus, onlineDrivers, revenue, gmv, pendingDrivers, pendingTopups, payouts, disputes, manualPayments, refunds] = await Promise.all([
      this.prisma.order.groupBy({ by: ['status'], where: { createdAt: { gte: today } }, _count: true }),
      this.prisma.driver.count({ where: { online: true, lastSeenAt: { gte: new Date(Date.now() - staleSec * 1000) } } }),
      this.prisma.ledgerEntry.aggregate({ where: { walletId: platform.id, type: 'commission', createdAt: { gte: today } }, _sum: { amountToea: true } }),
      this.prisma.order.aggregate({ where: { status: 'COMPLETED', completedAt: { gte: today } }, _sum: { priceToea: true }, _count: true }),
      this.prisma.driver.count({ where: { status: 'pending_approval' } }),
      this.prisma.topupRequest.count({ where: { status: 'pending' } }),
      this.prisma.payout.count({ where: { status: { in: ['requested', 'approved'] } } }),
      this.prisma.dispute.count({ where: { status: { in: ['open', 'investigating'] } } }),
      this.prisma.payment.count({ where: { adapter: 'manual', direction: 'in', purpose: 'order', status: { in: ['initiated', 'pending'] } } }),
      this.prisma.payment.count({ where: { purpose: 'refund', status: { in: ['initiated', 'pending', 'failed'] } } }),
    ]);
    return {
      date: today,
      ordersToday: { total: byStatus.reduce((a, s) => a + s._count, 0), byStatus: Object.fromEntries(byStatus.map((s) => [s.status, s._count])) },
      activeDrivers: onlineDrivers,
      revenueTodayToea: revenue._sum.amountToea ?? 0,
      completedToday: gmv._count,
      gmvTodayToea: gmv._sum.priceToea ?? 0,
      pending: { driverApprovals: pendingDrivers, topups: pendingTopups, payouts, disputes, manualPayments, refunds },
    };
  }

  /** Orders, revenue and commission per local day. */
  async daily(range: ReportRange) {
    return this.prisma.$queryRaw<
      { day: string; orders: number; completed: number; cancelled: number; expired: number; failed: number; gmv_toea: number; commission_toea: number; cod_toea: number; cellmoney_toea: number }[]
    >(Prisma.sql`
      SELECT to_char((o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Pacific/Port_Moresby')::date, 'YYYY-MM-DD') AS day,
             count(*)::int AS orders,
             count(*) FILTER (WHERE o.status = 'COMPLETED')::int AS completed,
             count(*) FILTER (WHERE o.status = 'CANCELLED')::int AS cancelled,
             count(*) FILTER (WHERE o.status = 'EXPIRED')::int AS expired,
             count(*) FILTER (WHERE o.status = 'FAILED')::int AS failed,
             COALESCE(sum(o.price_toea) FILTER (WHERE o.status = 'COMPLETED'), 0)::int AS gmv_toea,
             COALESCE(sum(o.commission_toea) FILTER (WHERE o.status = 'COMPLETED'), 0)::int AS commission_toea,
             COALESCE(sum(o.price_toea) FILTER (WHERE o.status = 'COMPLETED' AND o.payment_method = 'cod'), 0)::int AS cod_toea,
             COALESCE(sum(o.price_toea) FILTER (WHERE o.status = 'COMPLETED' AND o.payment_method = 'cellmoney'), 0)::int AS cellmoney_toea
      FROM orders o
      WHERE o.created_at >= ${range.from} AND o.created_at < ${range.to}
      GROUP BY 1
      ORDER BY 1`);
  }

  /** Money in by method: cash (COD completed), cell money (succeeded collections), bank (approved bank top-ups). */
  async paymentsByMethod(range: ReportRange) {
    const [cash, cellmoney, bank, refunds, payouts, commission] = await Promise.all([
      this.prisma.order.aggregate({ where: { paymentMethod: 'cod', status: 'COMPLETED', completedAt: { gte: range.from, lt: range.to } }, _sum: { priceToea: true }, _count: true }),
      this.prisma.payment.groupBy({
        by: ['purpose'],
        where: { provider: 'cellmoney', direction: 'in', status: 'succeeded', settledAt: { gte: range.from, lt: range.to } },
        _sum: { amountToea: true, feeToea: true },
        _count: true,
      }),
      this.prisma.topupRequest.aggregate({ where: { method: 'bank_transfer', status: 'approved', reviewedAt: { gte: range.from, lt: range.to } }, _sum: { amountToea: true }, _count: true }),
      this.prisma.payment.aggregate({ where: { purpose: 'refund', status: 'succeeded', settledAt: { gte: range.from, lt: range.to } }, _sum: { amountToea: true }, _count: true }),
      this.prisma.payout.aggregate({ where: { status: 'paid', processedAt: { gte: range.from, lt: range.to } }, _sum: { amountToea: true }, _count: true }),
      this.prisma.ledgerEntry.aggregate({
        where: { wallet: { ownerType: 'platform' }, type: 'commission', createdAt: { gte: range.from, lt: range.to } },
        _sum: { amountToea: true },
      }),
    ]);
    const cm = (purpose: string) => cellmoney.find((c) => c.purpose === purpose);
    return {
      from: range.from,
      to: range.to,
      cash: { orders: cash._count, amountToea: cash._sum.priceToea ?? 0 },
      cellmoney: {
        orders: { count: cm('order')?._count ?? 0, amountToea: cm('order')?._sum.amountToea ?? 0, feesToea: cm('order')?._sum.feeToea ?? 0 },
        topups: { count: cm('topup')?._count ?? 0, amountToea: cm('topup')?._sum.amountToea ?? 0, feesToea: cm('topup')?._sum.feeToea ?? 0 },
      },
      bank: { topups: bank._count, amountToea: bank._sum.amountToea ?? 0 },
      refunds: { count: refunds._count, amountToea: refunds._sum.amountToea ?? 0 },
      payouts: { count: payouts._count, amountToea: payouts._sum.amountToea ?? 0 },
      platformCommissionNetToea: commission._sum.amountToea ?? 0,
    };
  }

  async driverPerformance(range: ReportRange) {
    return this.prisma.$queryRaw<{ driver_id: string; name: string | null; phone: string; completed: number; gmv_toea: number; commission_toea: number; rating_avg: number }[]>(Prisma.sql`
      SELECT d.id AS driver_id, u.name, u.phone,
             count(o.id) FILTER (WHERE o.status = 'COMPLETED')::int AS completed,
             COALESCE(sum(o.price_toea) FILTER (WHERE o.status = 'COMPLETED'), 0)::int AS gmv_toea,
             COALESCE(sum(o.commission_toea) FILTER (WHERE o.status = 'COMPLETED'), 0)::int AS commission_toea,
             d.rating_avg
      FROM drivers d
      JOIN users u ON u.id = d.user_id
      LEFT JOIN orders o ON o.driver_id = d.id AND o.created_at >= ${range.from} AND o.created_at < ${range.to}
      GROUP BY d.id, u.name, u.phone
      ORDER BY completed DESC`);
  }

  /**
   * Day report: every order of one Port Moresby calendar day (by the day it was ordered, or the day it was
   * delivered), with times, people, truck, water, money, the customer's feedback, any dispute and the receipt.
   */
  async day(date: string, by: 'ordered' | 'delivered' = 'ordered') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
    if (!m) throw Errors.invalid('invalid_date', 'Date must look like 2026-11-20');
    const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - BUSINESS_UTC_OFFSET_HOURS * 3600_000);
    if (Number.isNaN(start.getTime())) throw Errors.invalid('invalid_date', 'Date must look like 2026-11-20');
    const end = new Date(start.getTime() + 24 * 3600_000);
    const window = { gte: start, lt: end };
    const orders = await this.prisma.order.findMany({
      where: by === 'delivered' ? { deliveredAt: window } : { createdAt: window },
      orderBy: by === 'delivered' ? { deliveredAt: 'asc' } : { createdAt: 'asc' },
      take: 5000,
      include: {
        package: true,
        customer: { select: { name: true, phone: true } },
        driver: { include: { user: { select: { name: true, phone: true } }, trucks: { where: { deletedAt: null }, take: 1, select: { plate: true, capacityLitres: true } } } },
        rating: true,
        disputes: { orderBy: { createdAt: 'desc' }, take: 1 },
        company: { select: { name: true } },
        signature: { select: { signedByName: true, signedAt: true } },
      },
    });
    const rows = orders.map((o) => ({
      id: o.id,
      shortCode: o.shortCode,
      status: o.status,
      orderedAt: o.createdAt,
      acceptedAt: o.acceptedAt,
      deliveredAt: o.deliveredAt,
      completedAt: o.completedAt,
      cancelledAt: o.cancelledAt ?? o.expiredAt ?? o.failedAt,
      cancelReason: o.cancelReason,
      minutesToDeliver: o.deliveredAt ? Math.round((o.deliveredAt.getTime() - o.createdAt.getTime()) / 60000) : null,
      customer: { name: o.customer.name, phone: o.customer.phone },
      company: o.company?.name ?? null,
      driver: o.driver ? { name: o.driver.user.name, phone: o.driver.user.phone } : null,
      truck: o.driver?.trucks[0] ?? null,
      package: o.package.name,
      quantity: o.quantity,
      litres: o.quantity * o.package.volumeLitres,
      address: o.deliveryAddress,
      priceToea: o.priceToea,
      discountToea: o.discountToea,
      paidToea: o.priceToea - o.discountToea,
      commissionToea: o.commissionToea,
      paymentMethod: o.paymentMethod,
      paymentStatus: o.paymentStatus,
      rating: o.rating ? { stars: o.rating.stars, comment: o.rating.comment } : null,
      dispute: o.disputes[0] ? { category: o.disputes[0].category, status: o.disputes[0].status, description: o.disputes[0].description } : null,
      signedBy: o.signature ? o.signature.signedByName || 'Customer' : null,
      receiptEmail: o.receiptSentAt ? o.receiptEmail : null,
    }));
    const done = rows.filter((r) => r.status === 'COMPLETED' || r.status === 'DELIVERED');
    const rated = rows.filter((r) => r.rating);
    const times = rows.map((r) => r.minutesToDeliver).filter((v): v is number => v !== null);
    return {
      date,
      by,
      summary: {
        orders: rows.length,
        delivered: done.length,
        cancelled: rows.filter((r) => ['CANCELLED', 'EXPIRED', 'FAILED'].includes(r.status)).length,
        litres: done.reduce((a, r) => a + r.litres, 0),
        salesToea: done.reduce((a, r) => a + r.paidToea, 0),
        commissionToea: done.reduce((a, r) => a + r.commissionToea, 0),
        averageStars: rated.length ? Math.round((rated.reduce((a, r) => a + r.rating!.stars, 0) / rated.length) * 10) / 10 : null,
        ratings: rated.length,
        disputes: rows.filter((r) => r.dispute).length,
        averageMinutesToDeliver: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
      },
      orders: rows,
    };
  }

  async dayCsv(date: string, by: 'ordered' | 'delivered' = 'ordered'): Promise<string> {
    const r = await this.day(date, by);
    const t = (d: Date | null) => (d ? formatLocal(d) : '');
    return toCsv(
      ['order', 'status', 'ordered_at', 'accepted_at', 'delivered_at', 'completed_at', 'minutes_to_deliver', 'customer', 'customer_phone', 'company', 'driver', 'driver_phone', 'truck', 'water', 'litres', 'address', 'price_kina', 'discount_kina', 'paid_kina', 'commission_kina', 'payment_method', 'payment_status', 'stars', 'feedback', 'dispute', 'signed_by', 'receipt_emailed_to', 'cancel_reason'],
      r.orders.map((o) => [
        o.shortCode,
        o.status,
        t(o.orderedAt),
        t(o.acceptedAt),
        t(o.deliveredAt),
        t(o.completedAt),
        o.minutesToDeliver ?? '',
        o.customer.name ?? '',
        o.customer.phone,
        o.company ?? '',
        o.driver?.name ?? '',
        o.driver?.phone ?? '',
        o.truck ? `${o.truck.plate} (${o.truck.capacityLitres} L)` : '',
        `${o.quantity} x ${o.package}`,
        o.litres,
        o.address,
        kina(o.priceToea),
        kina(o.discountToea),
        kina(o.paidToea),
        kina(o.commissionToea),
        o.paymentMethod,
        o.paymentStatus,
        o.rating?.stars ?? '',
        o.rating?.comment ?? '',
        o.dispute ? `${o.dispute.category} (${o.dispute.status}): ${o.dispute.description}` : '',
        o.signedBy ?? '',
        o.receiptEmail ?? '',
        o.cancelReason ?? '',
      ]),
    );
  }

  async ordersCsv(range: ReportRange): Promise<string> {
    const rows = await this.prisma.order.findMany({
      where: { createdAt: { gte: range.from, lt: range.to } },
      orderBy: { createdAt: 'asc' },
      include: { package: true, customer: { select: { phone: true } }, driver: { include: { user: { select: { phone: true } } } } },
      take: 50000,
    });
    return toCsv(
      ['short_code', 'created_at_utc', 'status', 'package', 'quantity', 'price_kina', 'commission_kina', 'payment_method', 'payment_status', 'customer_phone', 'driver_phone', 'completed_at_utc', 'cancel_reason'],
      rows.map((o) => [
        o.shortCode,
        o.createdAt.toISOString(),
        o.status,
        o.package.name,
        o.quantity,
        kina(o.priceToea),
        kina(o.commissionToea),
        o.paymentMethod,
        o.paymentStatus,
        o.customer.phone,
        o.driver?.user.phone ?? '',
        o.completedAt?.toISOString() ?? '',
        o.cancelReason ?? '',
      ]),
    );
  }

  async dailyCsv(range: ReportRange): Promise<string> {
    const rows = await this.daily(range);
    return toCsv(
      ['day', 'orders', 'completed', 'cancelled', 'expired', 'failed', 'gmv_kina', 'commission_kina', 'cash_kina', 'cellmoney_kina'],
      rows.map((r) => [r.day, r.orders, r.completed, r.cancelled, r.expired, r.failed, kina(r.gmv_toea), kina(r.commission_toea), kina(r.cod_toea), kina(r.cellmoney_toea)]),
    );
  }

  async paymentsCsv(range: ReportRange): Promise<string> {
    const rows = await this.prisma.payment.findMany({ where: { createdAt: { gte: range.from, lt: range.to } }, orderBy: { createdAt: 'asc' }, take: 50000 });
    return toCsv(
      ['id', 'created_at_utc', 'provider', 'adapter', 'direction', 'purpose', 'reference', 'status', 'amount_kina', 'fee_kina', 'provider_ref', 'msisdn', 'settled_at_utc'],
      rows.map((p) => [p.id, p.createdAt.toISOString(), p.provider, p.adapter, p.direction, p.purpose, p.reference, p.status, kina(p.amountToea), kina(p.feeToea), p.providerRef ?? '', p.msisdn ?? '', p.settledAt?.toISOString() ?? '']),
    );
  }
}

const kina = (toea: number) => (toea / 100).toFixed(2);

export function toCsv(header: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    let s = String(v);
    // Neutralise spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}
