import { Injectable, OnModuleInit } from '@nestjs/common';
import { Order, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { JobsService } from '../jobs/jobs.service';
import { GeoService } from '../geo/geo.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { LedgerService } from '../wallet/ledger.service';
import { PromosService } from '../promos/promos.service';
import { AfterCommit } from '../common/after-commit';
import { Errors } from '../common/errors';
import { computeCommission, formatKina } from '../common/money';
import { generateShortCode } from '../common/short-code';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';
import { OrderTransitionsService, humanStatus } from './transitions.service';
import { ACTIVE_DRIVER_STATUSES, customerMayCancel } from './state-machine';
import { ORDER_INCLUDE, adminOrderView, customerOrderView, driverOrderView } from './order-views';
import { AdminOrdersQuery, CreateOrderDto } from './orders.dto';

@Injectable()
export class OrdersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly geo: GeoService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly ledger: LedgerService,
    private readonly transitions: OrderTransitionsService,
    private readonly promos: PromosService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('orders.auto_complete', (d) => this.autoComplete(d.orderId));
    this.jobs.register('orders.fail_unpaid', (d) => this.failUnpaid(d.orderId));
  }

  /** A cell money order left without any open payment past the timeout fails (sweeper). Idempotent. */
  async failUnpaid(orderId: string): Promise<void> {
    await this.mutate(orderId, async (tx, order, effects) => {
      if (order.status !== 'PENDING_PAYMENT') return order;
      const open = await tx.payment.count({ where: { purpose: 'order', purposeId: orderId, status: { in: ['initiated', 'pending'] } } });
      if (open > 0) return order;
      const failed = await tx.order.update({ where: { id: orderId }, data: { paymentStatus: 'failed' } });
      return this.transitions.transition(tx, failed, 'FAILED', { type: 'system', id: null }, effects, { reason: 'Payment was not completed' });
    });
  }

  // ═══════════════ Customer ═══════════════

  /**
   * Fixed citywide price (§5 Package), less any promo discount. Commission is never shown to customers.
   * `payableToea` is what the customer pays.
   */
  async quote(packageId: string, quantity: number, promo?: { customerId: string; code?: string }) {
    const pkg = await this.prisma.package.findFirst({ where: { id: packageId, active: true, deletedAt: null } });
    if (!pkg) throw Errors.notFound('Package');
    const max = await this.settings.get('order.max_quantity');
    if (quantity > max) throw Errors.invalid('quantity_too_large', `You can order at most ${max} at a time`);
    const priceToea = pkg.priceToea * quantity;
    const applied = promo?.code ? await this.promos.evaluate(promo.code, promo.customerId, priceToea) : null;
    const discountToea = applied?.discountToea ?? 0;
    return {
      package: { id: pkg.id, name: pkg.name, volumeLitres: pkg.volumeLitres },
      quantity,
      unitPriceToea: pkg.priceToea,
      priceToea,
      discountToea,
      payableToea: priceToea - discountToea,
      promo: applied ? { code: applied.promo.code, description: applied.promo.description } : null,
    };
  }

  async create(customerId: string, dto: CreateOrderDto) {
    const q = await this.quote(dto.packageId, dto.quantity);
    const loc = await this.resolveLocation(customerId, dto);
    const [commissionType, commissionValue, deductAt] = await Promise.all([
      this.settings.get('commission.type'),
      this.settings.get('commission.value'),
      this.settings.get('commission.deduct_at'),
    ]);
    const commissionToea = computeCommission(q.priceToea, commissionType, commissionValue);
    const initial: OrderStatus = dto.paymentMethod === 'cellmoney' ? 'PENDING_PAYMENT' : 'SEARCHING';
    const paidFromWallet = dto.paymentMethod === 'wallet';

    const effects = new AfterCommit();
    const order = await this.withShortCodeRetry((shortCode) =>
      this.prisma.tx(async (tx) => {
        // Promo is (re)validated under a row lock so concurrent orders can't exceed its limits.
        const applied = dto.promoCode ? await this.promos.evaluate(dto.promoCode, customerId, q.priceToea, tx) : null;
        const discountToea = applied?.discountToea ?? 0;
        const payableToea = q.priceToea - discountToea;
        // Created in a pre-state then moved through the state machine so the first event is recorded too.
        const created = await tx.order.create({
          data: {
            shortCode,
            customerId,
            packageId: q.package.id,
            quantity: q.quantity,
            unitPriceToea: q.unitPriceToea,
            priceToea: q.priceToea,
            discountToea,
            promoCodeId: applied?.promo.id ?? null,
            commissionToea,
            commissionType,
            commissionValue,
            commissionDeductAt: deductAt,
            deliveryLat: loc.lat,
            deliveryLng: loc.lng,
            deliveryAddress: loc.address,
            deliveryNotes: loc.notes,
            paymentMethod: dto.paymentMethod,
            paymentStatus: dto.paymentMethod === 'cellmoney' ? 'pending' : paidFromWallet ? 'paid' : 'unpaid',
            status: 'PENDING_PAYMENT',
            paymentPendingAt: dto.paymentMethod === 'cellmoney' ? new Date() : null,
          },
        });
        if (applied) await this.promos.redeem(tx, applied.promo.id, customerId, created.id, discountToea);
        if (paidFromWallet && payableToea > 0) await this.payFromWallet(tx, customerId, created.id, created.shortCode, payableToea);
        if (initial === 'SEARCHING') {
          // COD / wallet go straight to dispatch; this single event records the creation.
          return this.transitions.transition(tx, created, 'SEARCHING', { type: 'system', id: null }, effects, {
            metadata: { created: true, createdBy: customerId, paymentMethod: dto.paymentMethod },
          });
        }
        await tx.orderEvent.create({
          data: { orderId: created.id, fromStatus: null, toStatus: 'PENDING_PAYMENT', actorType: 'customer', actorId: customerId, metadata: { created: true, paymentMethod: 'cellmoney' } },
        });
        return created;
      }),
    );
    await effects.run();
    return order;
  }

  /** Debit the customer's wallet for an order (inside the creating transaction). */
  private async payFromWallet(tx: Tx, customerId: string, orderId: string, shortCode: string, amountToea: number): Promise<void> {
    const wallet = await this.ledger.customerWallet(customerId, tx);
    const locked = await this.ledger.lockWallet(tx, wallet.id);
    if (locked.balanceToea < amountToea) {
      throw Errors.invalid(
        'wallet_insufficient',
        `Your wallet has ${formatKina(locked.balanceToea)}. Top up ${formatKina(amountToea - locked.balanceToea)} more or choose another payment method.`,
        { balanceToea: locked.balanceToea, amountToea },
      );
    }
    await this.ledger.post(tx, {
      walletId: wallet.id,
      amountToea: -amountToea,
      type: 'order_payment',
      referenceType: 'order',
      referenceId: orderId,
      idempotencyKey: `order-payment:${orderId}`,
      createdBy: `customer:${customerId}`,
      description: `Payment for ${shortCode}`,
    });
  }

  async listForCustomer(customerId: string, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.order.findMany({
      where: { AND: [{ customerId }, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: ORDER_INCLUDE,
    });
    const page = toPage(rows, limit);
    return { items: page.items.map(customerOrderView), nextCursor: page.nextCursor };
  }

  async getForCustomer(customerId: string, orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!o || o.customerId !== customerId) throw Errors.notFound('Order');
    return customerOrderView(o);
  }

  async cancelByCustomer(customerId: string, orderId: string, reason: string) {
    const freeUntil = (await this.settings.get('order.customer_cancel_free_until')) as OrderStatus;
    return this.mutate(orderId, async (tx, order, effects) => {
      if (order.customerId !== customerId) throw Errors.notFound('Order');
      if (!customerMayCancel(order.status, freeUntil)) {
        throw Errors.conflict('cancel_not_allowed', `This order is ${humanStatus(order.status)} and can no longer be cancelled in the app. Please contact Cooper Waters support.`);
      }
      return this.transitions.transition(tx, order, 'CANCELLED', { type: 'customer', id: customerId }, effects, { reason });
    });
  }

  async confirmReceipt(customerId: string, orderId: string) {
    return this.mutate(orderId, async (tx, order, effects) => {
      if (order.customerId !== customerId) throw Errors.notFound('Order');
      return this.transitions.transition(tx, order, 'COMPLETED', { type: 'customer', id: customerId }, effects, { metadata: { confirmedBy: 'customer' } });
    });
  }

  /** Job: auto-confirm receipt after order.auto_complete_after_sec (§4). Idempotent. */
  async autoComplete(orderId: string): Promise<void> {
    const after = await this.settings.get('order.auto_complete_after_sec');
    await this.mutate(orderId, async (tx, order, effects) => {
      if (order.status !== 'DELIVERED' || !order.deliveredAt) return order;
      if (order.deliveredAt.getTime() + after * 1000 > Date.now() + 2000) return order;
      return this.transitions.transition(tx, order, 'COMPLETED', { type: 'system', id: null }, effects, { metadata: { auto: true } });
    }).catch((err) => {
      if (err?.response?.error?.code !== 'not_found') throw err;
    });
  }

  // ═══════════════ Driver ═══════════════

  async openOffers(driverId: string) {
    const offers = await this.prisma.orderOffer.findMany({
      where: { driverId, response: null, order: { status: 'SEARCHING' } },
      include: { order: { include: { package: true } } },
      orderBy: { sentAt: 'desc' },
    });
    return offers.map((o) => ({
      offerId: o.id,
      orderId: o.orderId,
      shortCode: o.order.shortCode,
      package: o.order.package.name,
      volumeLitres: o.order.package.volumeLitres * o.order.quantity,
      quantity: o.order.quantity,
      distanceM: o.distanceM,
      earningsToea: o.order.priceToea - o.order.commissionToea,
      priceToea: o.order.priceToea,
      paymentMethod: o.order.paymentMethod,
      expiresAt: o.order.expiresAt,
      delivery: { lat: o.order.deliveryLat, lng: o.order.deliveryLng, address: o.order.deliveryAddress, notes: o.order.deliveryNotes },
    }));
  }

  /**
   * First-come-first-served, race-safe accept (§6). The driver row is locked first (one active order),
   * then the order row; only the transaction that still sees SEARCHING wins, everyone else gets 409.
   */
  async accept(driverId: string, orderId: string) {
    const minBalance = await this.settings.get('wallet.min_balance_toea');
    const oneActive = await this.settings.get('order.one_active_per_driver');
    const effects = new AfterCommit();
    const order = await this.prisma.tx(async (tx) => {
      await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId}::uuid FOR UPDATE`;
      const driver = await tx.driver.findUniqueOrThrow({ where: { id: driverId } });
      await this.assertCanWork(tx, driver, minBalance, oneActive);
      const order = await this.transitions.lock(tx, orderId);
      if (order.status !== 'SEARCHING') throw Errors.conflict('order_taken', 'Sorry, this job has already been taken');
      const offer = await tx.orderOffer.findFirst({ where: { orderId, driverId }, orderBy: { round: 'desc' } });
      if (!offer || offer.response === 'declined') throw Errors.forbidden('This job was not offered to you');
      const accepted = await this.transitions.transition(tx, order, 'ACCEPTED', { type: 'driver', id: driverId }, effects, {
        data: { driverId },
        metadata: { offerId: offer.id, round: offer.round },
      });
      await tx.orderOffer.update({ where: { id: offer.id }, data: { response: 'accepted', respondedAt: new Date() } });
      return accepted;
    });
    await effects.run();
    return this.getForDriver(driverId, order.id);
  }

  async decline(driverId: string, orderId: string) {
    const r = await this.prisma.orderOffer.updateMany({ where: { orderId, driverId, response: null }, data: { response: 'declined', respondedAt: new Date() } });
    if (r.count === 0) throw Errors.notFound('Offer');
  }

  async activeForDriver(driverId: string) {
    const o = await this.prisma.order.findFirst({
      where: { driverId, status: { in: [...ACTIVE_DRIVER_STATUSES, 'DELIVERED', 'DISPUTED'] } },
      orderBy: { acceptedAt: 'desc' },
      include: ORDER_INCLUDE,
    });
    return o ? driverOrderView(o) : null;
  }

  async getForDriver(driverId: string, orderId: string) {
    const o = await this.prisma.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE });
    if (!o || o.driverId !== driverId) throw Errors.notFound('Order');
    return driverOrderView(o);
  }

  async historyForDriver(driverId: string, q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.order.findMany({
      where: { AND: [{ driverId }, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: ORDER_INCLUDE,
    });
    const page = toPage(rows, limit);
    return { items: page.items.map(driverOrderView), nextCursor: page.nextCursor };
  }

  /** ACCEPTED → LOADING: the driver is at a depot (geofence check, §7.5). */
  async arriveAtDepot(driverId: string, orderId: string, lat: number, lng: number) {
    const depot = await this.geo.depotAt(lat, lng);
    if (!depot) throw Errors.invalid('not_at_depot', 'You need to be at a Cooper Waters depot to load water');
    return this.driverStep(driverId, orderId, 'LOADING', { depotId: depot.id, depotName: depot.name, lat, lng });
  }

  /** LOADING → EN_ROUTE: confirm loaded, only inside a depot geofence (§7.5). */
  async confirmLoaded(driverId: string, orderId: string, lat: number, lng: number) {
    const depot = await this.geo.depotAt(lat, lng);
    if (!depot) throw Errors.invalid('not_at_depot', 'Confirm loading while you are still at the depot');
    return this.driverStep(driverId, orderId, 'EN_ROUTE', { depotId: depot.id, lat, lng });
  }

  async markArrived(driverId: string, orderId: string, lat?: number, lng?: number) {
    return this.driverStep(driverId, orderId, 'ARRIVED', lat !== undefined ? { lat, lng } : {});
  }

  async markDelivered(driverId: string, orderId: string, proofPhotoKey?: string) {
    if (proofPhotoKey) this.storage.assertOwnedKey(proofPhotoKey, 'proof-of-delivery', driverId);
    return this.driverStep(driverId, orderId, 'DELIVERED', { proofPhotoKey }, proofPhotoKey ? { proofPhotoKey } : undefined);
  }

  private async driverStep(driverId: string, orderId: string, to: OrderStatus, metadata: Record<string, unknown>, data?: Prisma.OrderUncheckedUpdateInput) {
    await this.mutate(orderId, async (tx, order, effects) => {
      if (order.driverId !== driverId) throw Errors.notFound('Order');
      return this.transitions.transition(tx, order, to, { type: 'driver', id: driverId }, effects, { metadata, data });
    });
    return this.getForDriver(driverId, orderId);
  }

  // ═══════════════ Admin ═══════════════

  async adminList(q: AdminOrdersQuery) {
    const limit = pageLimit(q);
    const where: Prisma.OrderWhereInput = {};
    if (q.status) where.status = { in: q.status.split(',') as OrderStatus[] };
    if (q.driverId) where.driverId = q.driverId;
    if (q.customerId) where.customerId = q.customerId;
    if (q.paymentMethod) where.paymentMethod = q.paymentMethod;
    if (q.from || q.to) where.createdAt = { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined };
    if (q.q) {
      const s = q.q.trim();
      where.OR = [
        { shortCode: { contains: s.toUpperCase() } },
        { customer: { phone: { contains: s } } },
        { customer: { name: { contains: s, mode: 'insensitive' } } },
        { driver: { user: { phone: { contains: s } } } },
        { driver: { user: { name: { contains: s, mode: 'insensitive' } } } },
      ];
    }
    const rows = await this.prisma.order.findMany({ where: { AND: [where, cursorWhere(q.cursor)] }, orderBy: pageOrder, take: limit + 1, include: ORDER_INCLUDE });
    const page = toPage(rows, limit);
    return { items: page.items.map(adminOrderView), nextCursor: page.nextCursor };
  }

  async adminGet(orderId: string) {
    const o = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { ...ORDER_INCLUDE, events: { orderBy: { createdAt: 'asc' } } },
    });
    if (!o) throw Errors.notFound('Order');
    const [offers, payments, disputes, rating] = await Promise.all([
      this.prisma.orderOffer.findMany({ where: { orderId }, include: { driver: { include: { user: { select: { name: true, phone: true } } } } }, orderBy: { sentAt: 'asc' } }),
      this.prisma.payment.findMany({ where: { purposeId: orderId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.dispute.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.rating.findUnique({ where: { orderId } }),
    ]);
    const proofPhotoUrl = o.proofPhotoKey ? await this.storage.presignDownload(o.proofPhotoKey).catch(() => null) : null;
    return {
      ...adminOrderView(o),
      proofPhotoUrl,
      offers: offers.map((f) => ({ id: f.id, driverId: f.driverId, driverName: f.driver.user.name, round: f.round, distanceM: f.distanceM, sentAt: f.sentAt, response: f.response, respondedAt: f.respondedAt })),
      payments,
      disputes,
      rating,
    };
  }

  async adminCancel(adminId: string, orderId: string, reason: string, ip: string | null) {
    const res = await this.mutate(orderId, async (tx, order, effects) => {
      const after = await this.transitions.transition(tx, order, 'CANCELLED', { type: 'admin', id: adminId }, effects, { reason });
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'order.cancel', entity: 'order', entityId: orderId, before: order, after, ip }, tx);
      return after;
    });
    return res;
  }

  /** Reassign (§10): release back to dispatch, or hand directly to a named driver. */
  async adminReassign(adminId: string, orderId: string, driverId: string | undefined, reason: string, ip: string | null) {
    const minBalance = await this.settings.get('wallet.min_balance_toea');
    const oneActive = await this.settings.get('order.one_active_per_driver');
    const effects = new AfterCommit();
    const result = await this.prisma.tx(async (tx) => {
      if (driverId) {
        await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId}::uuid FOR UPDATE`;
        const driver = await tx.driver.findUnique({ where: { id: driverId } });
        if (!driver) throw Errors.notFound('Driver');
        await this.assertCanWork(tx, driver, minBalance, oneActive, orderId, false);
      }
      const order = await this.transitions.lock(tx, orderId);
      if (driverId && order.driverId === driverId) throw Errors.conflict('same_driver', 'The order is already assigned to this driver');
      const after = driverId
        ? await this.transitions.transition(tx, order, 'ACCEPTED', { type: 'admin', id: adminId }, effects, { data: { driverId }, reason, metadata: { reassignedFrom: order.driverId, reason } })
        : await this.transitions.transition(tx, order, 'SEARCHING', { type: 'admin', id: adminId }, effects, { reason, metadata: { releasedFrom: order.driverId, reason } });
      await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'order.reassign', entity: 'order', entityId: orderId, before: order, after, ip }, tx);
      return after;
    });
    await effects.run();
    return result;
  }

  // ═══════════════ Helpers ═══════════════

  /** Lock → mutate → commit → run effects. */
  async mutate(orderId: string, fn: (tx: Tx, order: Order, effects: AfterCommit) => Promise<Order>): Promise<Order> {
    const effects = new AfterCommit();
    const result = await this.prisma.tx(async (tx) => fn(tx, await this.transitions.lock(tx, orderId), effects));
    await effects.run();
    return result;
  }

  /** §6: approved, online, wallet ≥ minimum, and (if configured) no other active order. */
  private async assertCanWork(
    tx: Tx,
    driver: { id: string; status: string; online: boolean },
    minBalance: number,
    oneActive: boolean,
    exceptOrderId?: string,
    requireOnline = true,
  ): Promise<void> {
    if (driver.status !== 'approved') throw Errors.forbidden('Your driver account is not approved');
    if (requireOnline && !driver.online) throw Errors.conflict('driver_offline', 'Go online to accept jobs');
    const wallet = await this.ledger.driverWallet(driver.id, tx);
    if (wallet.balanceToea < minBalance) {
      throw Errors.conflict('wallet_below_minimum', `Top up your wallet to at least ${formatKina(minBalance)} to take jobs`, {
        balanceToea: wallet.balanceToea,
        minBalanceToea: minBalance,
      });
    }
    if (oneActive) {
      const active = await tx.order.count({
        where: { driverId: driver.id, status: { in: ACTIVE_DRIVER_STATUSES }, ...(exceptOrderId ? { id: { not: exceptOrderId } } : {}) },
      });
      if (active > 0) throw Errors.conflict('driver_busy', 'Finish your current job before taking another');
    }
  }

  private async resolveLocation(customerId: string, dto: CreateOrderDto) {
    if (dto.locationId) {
      const l = await this.prisma.customerLocation.findFirst({ where: { id: dto.locationId, userId: customerId, deletedAt: null } });
      if (!l) throw Errors.notFound('Saved location');
      return { lat: l.lat, lng: l.lng, address: l.addressText, notes: l.landmarkNotes };
    }
    if (!dto.location) throw Errors.invalid('location_required', 'Choose where to deliver');
    return { lat: dto.location.lat, lng: dto.location.lng, address: dto.location.address, notes: dto.location.notes ?? '' };
  }

  private async withShortCodeRetry<T>(fn: (code: string) => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn(generateShortCode());
      } catch (err) {
        const clash = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && String(err.meta?.target ?? '').includes('short_code');
        if (!clash || i >= 5) throw err;
      }
    }
  }
}
