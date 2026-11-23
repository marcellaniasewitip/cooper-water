import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Company, OrderStatus } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { LedgerService } from '../wallet/ledger.service';
import { AuditService } from '../audit/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { EMAIL_PROVIDER, EmailProvider } from '../notifications/email.provider';
import { Errors } from '../common/errors';
import { formatKina } from '../common/money';
import { normalisePhone } from '../common/phone';
import { BUSINESS_UTC_OFFSET_HOURS, formatLocal } from '../common/time';
import { logger } from '../common/logger';
import { toCsv } from '../reports/reports.service';

/** Orders that never went ahead don't count on a statement. */
const NOT_BILLED: OrderStatus[] = ['PENDING_PAYMENT', 'CANCELLED', 'EXPIRED', 'FAILED'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface CompanyInput {
  name?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  creditLimitToea?: number;
  active?: boolean;
}

/** "2026-11" → [start, end) of that month in Port Moresby time, as UTC instants. */
export function monthRange(month: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw Errors.invalid('invalid_month', 'Month must look like 2026-11');
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const off = BUSINESS_UTC_OFFSET_HOURS * 3600_000;
  return { from: new Date(Date.UTC(y, mo, 1) - off), to: new Date(Date.UTC(y, mo + 1, 1) - off) };
}

/** Port Moresby month key ("2026-11") containing `at`, shifted by `delta` months. */
export function monthKey(at: Date, delta = 0): string {
  const local = new Date(at.getTime() + BUSINESS_UTC_OFFSET_HOURS * 3600_000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Corporate accounts: employees order "on account", each order is debited to the company's ledger wallet
 * (balance goes negative = amount owed, down to the credit limit), admin records the company's payments, and
 * a statement with the month's totals is written (and emailed to the contact) automatically after month end.
 */
@Injectable()
export class CompaniesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  onModuleInit(): void {
    this.jobs.register('companies.close_months', (d) => this.closeMonths(d?.at ? new Date(d.at) : new Date()).then(() => undefined));
  }

  wallet(companyId: string, db: Tx | PrismaService = this.prisma) {
    return this.ledger.walletFor('company', companyId, db);
  }

  private view(c: Company, balanceToea: number, employees?: number) {
    const owedToea = Math.max(0, -balanceToea);
    return {
      ...c,
      balanceToea,
      owedToea,
      availableToea: c.creditLimitToea + balanceToea,
      ...(employees !== undefined ? { employeeCount: employees } : {}),
    };
  }

  async list() {
    const companies = await this.prisma.company.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { employees: true } } } });
    const wallets = await this.prisma.wallet.findMany({ where: { ownerType: 'company', ownerId: { in: companies.map((c) => c.id) } } });
    const bal = new Map(wallets.map((w) => [w.ownerId, w.balanceToea]));
    return companies.map(({ _count, ...c }) => this.view(c, bal.get(c.id) ?? 0, _count.employees));
  }

  async get(id: string) {
    const c = await this.prisma.company.findUnique({ where: { id } });
    if (!c) throw Errors.notFound('Company');
    const [wallet, employees, statements, payments] = await Promise.all([
      this.wallet(id),
      this.prisma.user.findMany({ where: { companyId: id }, select: { id: true, name: true, phone: true, email: true }, orderBy: { name: 'asc' } }),
      this.prisma.companyStatement.findMany({ where: { companyId: id }, orderBy: { month: 'desc' }, take: 24 }),
      this.prisma.ledgerEntry.findMany({
        where: { wallet: { ownerType: 'company', ownerId: id }, type: 'company_payment' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, amountToea: true, description: true, createdAt: true, createdBy: true },
      }),
    ]);
    const currentMonth = await this.monthSummary(id, monthKey(new Date()));
    return { ...this.view(c, wallet.balanceToea, employees.length), employees, statements, currentMonth, payments };
  }

  private clean(dto: CompanyInput) {
    const out: CompanyInput = {};
    if (dto.name !== undefined) {
      out.name = dto.name.trim();
      if (!out.name) throw Errors.invalid('name_required', 'Enter the company name');
    }
    if (dto.contactName !== undefined) out.contactName = dto.contactName.trim();
    if (dto.contactPhone !== undefined) out.contactPhone = dto.contactPhone.trim();
    if (dto.contactEmail !== undefined) {
      out.contactEmail = dto.contactEmail.trim().toLowerCase();
      if (out.contactEmail && !EMAIL_RE.test(out.contactEmail)) throw Errors.invalid('email_invalid', 'Enter a valid email address');
    }
    if (dto.creditLimitToea !== undefined) out.creditLimitToea = dto.creditLimitToea;
    if (dto.active !== undefined) out.active = dto.active;
    return out;
  }

  async create(adminId: string, dto: CompanyInput, ip?: string) {
    const data = this.clean(dto);
    if (!data.name) throw Errors.invalid('name_required', 'Enter the company name');
    const c = await this.prisma.company.create({ data: { ...data, name: data.name } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'company.create', entity: 'company', entityId: c.id, after: c, ip });
    return this.view(c, 0, 0);
  }

  async update(adminId: string, id: string, dto: CompanyInput, ip?: string) {
    const before = await this.prisma.company.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Company');
    const c = await this.prisma.company.update({ where: { id }, data: this.clean(dto) });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'company.update', entity: 'company', entityId: id, before, after: c, ip });
    return this.get(id);
  }

  /** Link a customer (by the phone they signed up with) so they can order on the company's account. */
  async addEmployee(adminId: string, companyId: string, rawPhone: string, ip?: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw Errors.notFound('Company');
    const phone = normalisePhone(rawPhone);
    const user = await this.prisma.user.findUnique({ where: { phone } });
    if (!user || user.role !== 'customer' || user.deletedAt) {
      throw Errors.notFound(`Customer ${phone} (ask them to sign up in the Cooper Waters app first)`);
    }
    if (user.companyId && user.companyId !== companyId) {
      throw Errors.conflict('in_other_company', 'This customer is already on another company account. Remove them there first.');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { companyId } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'company.employee_add', entity: 'company', entityId: companyId, after: { userId: user.id, phone }, ip });
    return { id: user.id, name: user.name, phone: user.phone, email: user.email };
  }

  async removeEmployee(adminId: string, companyId: string, userId: string, ip?: string) {
    const r = await this.prisma.user.updateMany({ where: { id: userId, companyId }, data: { companyId: null } });
    if (r.count === 0) throw Errors.notFound('Employee');
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'company.employee_remove', entity: 'company', entityId: companyId, before: { userId }, ip });
  }

  /** The company paid its bill (bank transfer, cheque…): credit the account. */
  async recordPayment(adminId: string, companyId: string, amountToea: number, reference: string, idempotencyKey: string, ip?: string) {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company) throw Errors.notFound('Company');
    if (!Number.isInteger(amountToea) || amountToea <= 0) throw Errors.invalid('invalid_amount', 'Enter an amount above zero');
    const entry = await this.prisma.tx(async (tx) => {
      const w = await this.wallet(companyId, tx);
      const { entry } = await this.ledger.post(tx, {
        walletId: w.id,
        amountToea,
        type: 'company_payment',
        referenceType: 'company',
        referenceId: companyId,
        idempotencyKey: `company-payment:${companyId}:${idempotencyKey}`,
        createdBy: `admin:${adminId}`,
        description: reference.trim() ? `Payment received · ${reference.trim()}` : 'Payment received',
      });
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'company.payment', entity: 'company', entityId: companyId, after: entry, ip }, tx);
      return entry;
    });
    return { entry, company: await this.get(companyId) };
  }

  /**
   * Charge an order to the employee's company (inside the order-creating transaction). Returns the company id.
   * The company may owe at most its credit limit after this order.
   */
  async chargeOrder(tx: Tx, userId: string, orderId: string, shortCode: string, amountToea: number): Promise<string> {
    const user = await tx.user.findUnique({ where: { id: userId }, include: { company: true } });
    const company = user?.company;
    if (!company || !company.active) {
      throw Errors.invalid('no_company_account', 'You are not on an active company account. Choose another payment method.');
    }
    const w = await this.wallet(company.id, tx);
    const locked = await this.ledger.lockWallet(tx, w.id);
    const available = company.creditLimitToea + locked.balanceToea;
    if (available < amountToea) {
      throw Errors.invalid(
        'credit_limit_reached',
        `${company.name}'s account has ${formatKina(Math.max(0, available))} of credit left. Ask your company to pay its bill, or choose another payment method.`,
        { availableToea: available, amountToea },
      );
    }
    await this.ledger.post(tx, {
      walletId: w.id,
      amountToea: -amountToea,
      type: 'order_payment',
      referenceType: 'order',
      referenceId: orderId,
      idempotencyKey: `order-payment:${orderId}`,
      createdBy: `customer:${userId}`,
      description: `Order ${shortCode}`,
    });
    return company.id;
  }

  /** Give the charge back to the company (order cancelled / expired / refunded in a dispute). */
  async refundOrder(tx: Tx, order: { id: string; companyId: string | null; shortCode: string; priceToea: number; discountToea: number }, amountToea: number | undefined, reason: string) {
    if (!order.companyId) return false;
    const paid = order.priceToea - order.discountToea;
    const amount = Math.min(amountToea ?? paid, paid);
    if (amount <= 0) return false;
    const w = await this.wallet(order.companyId, tx);
    const { created } = await this.ledger.post(tx, {
      walletId: w.id,
      amountToea: amount,
      type: 'refund',
      referenceType: 'order',
      referenceId: order.id,
      idempotencyKey: `account-refund:${order.id}`,
      createdBy: 'system',
      description: `Refund ${order.shortCode} · ${reason}`.slice(0, 200),
    });
    return created;
  }

  /** Totals for one month, worked out from the company's ledger and orders. */
  async monthSummary(companyId: string, month: string) {
    const { from, to } = monthRange(month);
    const wallet = await this.wallet(companyId);
    const [opening, inMonth, payments, orders] = await Promise.all([
      this.prisma.ledgerEntry.aggregate({ where: { walletId: wallet.id, createdAt: { lt: from } }, _sum: { amountToea: true } }),
      this.prisma.ledgerEntry.aggregate({ where: { walletId: wallet.id, createdAt: { gte: from, lt: to } }, _sum: { amountToea: true } }),
      this.prisma.ledgerEntry.aggregate({ where: { walletId: wallet.id, type: 'company_payment', createdAt: { gte: from, lt: to } }, _sum: { amountToea: true } }),
      this.prisma.order.findMany({
        where: { companyId, paymentMethod: 'account', createdAt: { gte: from, lt: to }, status: { notIn: NOT_BILLED } },
        select: { quantity: true, package: { select: { volumeLitres: true } } },
      }),
    ]);
    const openingBalanceToea = opening._sum.amountToea ?? 0;
    const movement = inMonth._sum.amountToea ?? 0;
    const paymentsToea = payments._sum.amountToea ?? 0;
    return {
      month,
      orderCount: orders.length,
      litres: orders.reduce((a, o) => a + o.quantity * o.package.volumeLitres, 0),
      chargedToea: paymentsToea - movement,
      paymentsToea,
      openingBalanceToea,
      closingBalanceToea: openingBalanceToea + movement,
    };
  }

  /** Every order charged to the company in a month, for the statement CSV. */
  async monthCsv(companyId: string, month: string): Promise<string> {
    const { from, to } = monthRange(month);
    const orders = await this.prisma.order.findMany({
      where: { companyId, paymentMethod: 'account', createdAt: { gte: from, lt: to } },
      orderBy: { createdAt: 'asc' },
      include: { package: true, customer: { select: { name: true, phone: true } }, driver: { include: { user: { select: { name: true } } } } },
    });
    const kina = (t: number) => (t / 100).toFixed(2);
    return toCsv(
      ['order', 'ordered_at', 'delivered_at', 'employee', 'phone', 'water', 'litres', 'driver', 'address', 'status', 'amount_kina', 'billed'],
      orders.map((o) => [
        o.shortCode,
        formatLocal(o.createdAt),
        o.deliveredAt ? formatLocal(o.deliveredAt) : '',
        o.customer.name ?? '',
        o.customer.phone,
        `${o.quantity} x ${o.package.name}`,
        o.quantity * o.package.volumeLitres,
        o.driver?.user.name ?? '',
        o.deliveryAddress,
        o.status,
        kina(o.priceToea - o.discountToea),
        NOT_BILLED.includes(o.status) ? 'no' : 'yes',
      ]),
    );
  }

  /**
   * Month end (run by the sweeper): write last month's statement for each company that doesn't have one yet,
   * and email it to the company's contact. Idempotent thanks to the (companyId, month) unique key.
   */
  async closeMonths(now = new Date()): Promise<number> {
    // Last month, plus any earlier month that was missed (e.g. the server was down over a month end), up to 12 back.
    const months = Array.from({ length: 12 }, (_, i) => monthKey(now, -12 + i));
    let written = 0;
    for (const month of months) {
      const { to } = monthRange(month);
      const due = await this.prisma.company.findMany({ where: { createdAt: { lt: to }, statements: { none: { month } } }, take: 50 });
      for (const c of due) {
        const s = await this.monthSummary(c.id, month);
        try {
          const st = await this.prisma.companyStatement.create({ data: { companyId: c.id, ...s } });
          written++;
          // Only the most recent month is emailed; catch-up months are just recorded.
          if (c.contactEmail && month === monthKey(now, -1)) await this.emailStatement(c, st.id);
        } catch (err: any) {
          if (err?.code !== 'P2002') logger.warn({ companyId: c.id, month, err: String(err?.message ?? err) }, 'statement failed');
        }
      }
    }
    return written;
  }

  private async emailStatement(c: Company, statementId: string) {
    const s = await this.prisma.companyStatement.findUniqueOrThrow({ where: { id: statementId } });
    const rows: [string, string][] = [
      ['Month', s.month],
      ['Orders', String(s.orderCount)],
      ['Water delivered', `${s.litres.toLocaleString('en-US')} L`],
      ['Opening balance', formatKina(s.openingBalanceToea)],
      ['Charged this month', formatKina(s.chargedToea)],
      ['Payments received', formatKina(s.paymentsToea)],
      ['Closing balance', formatKina(s.closingBalanceToea)],
      ['Amount owed', formatKina(Math.max(0, -s.closingBalanceToea))],
    ];
    const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1b2b3a;background:#f4f7fb;padding:24px">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px"><tr><td>
<h2 style="margin:0 0 4px;color:#0b5394">Cooper Waters</h2><p style="margin:0 0 16px;color:#5c6b7a">Monthly statement · ${esc(c.name)}</p>
<table role="presentation" width="100%" style="border-collapse:collapse;font-size:14px">
${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#5c6b7a;width:50%">${esc(k)}</td><td style="padding:6px 0;font-weight:600">${esc(v)}</td></tr>`).join('\n')}
</table><p style="margin:24px 0 0;color:#8a96a3;font-size:12px">A line-by-line list of orders is available from Cooper Waters on request.</p>
</td></tr></table></body></html>`;
    const text = [`Cooper Waters — monthly statement · ${c.name}`, '', ...rows.map(([k, v]) => `${k}: ${v}`)].join('\n');
    try {
      await this.email.send({ to: c.contactEmail, subject: `Cooper Waters statement ${s.month} · ${c.name}`, html, text });
      await this.prisma.companyStatement.update({ where: { id: s.id }, data: { emailedTo: c.contactEmail, emailedAt: new Date() } });
    } catch (err) {
      logger.warn({ companyId: c.id, err: String((err as Error)?.message ?? err) }, 'statement email failed');
    }
  }

  /** For the customer app: the employee's company and how much they can still order on account. */
  async forCustomer(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, include: { company: true } });
    if (!u?.company || !u.company.active) return null;
    const w = await this.wallet(u.company.id);
    return { id: u.company.id, name: u.company.name, availableToea: Math.max(0, u.company.creditLimitToea + w.balanceToea) };
  }
}
