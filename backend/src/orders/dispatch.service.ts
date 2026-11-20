import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { JobsService } from '../jobs/jobs.service';
import { GeoService } from '../geo/geo.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { AfterCommit } from '../common/after-commit';
import { formatKina } from '../common/money';
import { logger } from '../common/logger';
import { OrderTransitionsService } from './transitions.service';

/**
 * Dispatch (§7): broadcast offers to eligible drivers by radius rounds; widen and re-broadcast when a
 * round times out; expire after the last round. Jobs are idempotent — they check (status, round) under lock.
 */
@Injectable()
export class DispatchService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly jobs: JobsService,
    private readonly geo: GeoService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly transitions: OrderTransitionsService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('dispatch.broadcast', (d) => this.broadcast(d.orderId, d.round).then(() => undefined));
    this.jobs.register('dispatch.round_timeout', (d) => this.roundTimeout(d.orderId, d.round));
    this.jobs.register('dispatch.auto_next', (d) => this.autoNext(d.orderId, d.offerId ?? null));
  }

  autoAssign(): Promise<boolean> {
    return this.settings.get('dispatch.auto_assign');
  }

  /**
   * Auto-assign: place the order with the nearest eligible driver not yet tried, unless one already holds it.
   * The driver gets the usual offer; the customer and admins are told who it was placed with. A timer moves it on
   * if the driver does not answer. Returns the offer id, or null when nobody (else) is available in this round.
   */
  async offerNextAuto(orderId: string): Promise<string | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { package: true } });
    if (!order || order.status !== 'SEARCHING') return null;
    const pending = await this.prisma.orderOffer.findFirst({ where: { orderId, response: null } });
    if (pending) return null;
    const radius = await this.radiusForRound(order.dispatchRound);
    const drivers = await this.geo.eligibleDrivers(order.id, order.deliveryLat, order.deliveryLng, radius);
    for (const d of drivers) {
      let offerId: string;
      try {
        const offer = await this.prisma.orderOffer.create({ data: { orderId, driverId: d.driverId, round: order.dispatchRound, distanceM: d.distanceM } });
        offerId = offer.id;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue;
        throw err;
      }
      // Another worker may have placed it with someone else at the same moment: keep only the first.
      const open = await this.prisma.orderOffer.findMany({ where: { orderId, response: null }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }] });
      if (open.length > 1 && open[0].id !== offerId) {
        await this.prisma.orderOffer.delete({ where: { id: offerId } });
        return null;
      }
      const driver = await this.prisma.driver.findUnique({ where: { id: d.driverId }, include: { user: { select: { name: true } }, trucks: { select: { plate: true }, take: 1 } } });
      const driverName = driver?.user.name || 'a driver';
      await this.sendOffer(offerId, d.userId, order, d.distanceM);
      const timeoutSec = await this.settings.get('dispatch.auto_assign_timeout_sec');
      await this.jobs.enqueue('orders', 'dispatch.auto_next', { orderId, offerId }, { delayMs: timeoutSec * 1000, jobId: `auto-${offerId}` });
      const message = `Order ${order.shortCode} is placed to ${driverName}`;
      this.realtime.toAdmins('order.auto_assigned', { orderId, shortCode: order.shortCode, driverId: d.driverId, driverName, plate: driver?.trucks[0]?.plate ?? null, message });
      this.realtime.toUser(order.customerId, 'order.auto_assigned', { orderId, driverName, message });
      await this.notifications.notify(order.customerId, 'order.auto_assigned', { orderId, shortCode: order.shortCode, driverName });
      logger.info({ orderId, driverId: d.driverId, distanceM: d.distanceM }, 'order auto-assigned');
      return offerId;
    }
    return null;
  }

  /**
   * Auto-assign timer fired or the driver declined: when the offer (if given) is still unanswered, take it back
   * and place the order with the next nearest driver.
   */
  async autoNext(orderId: string, offerId: string | null): Promise<void> {
    if (offerId) {
      const offer = await this.prisma.orderOffer.findUnique({ where: { id: offerId }, include: { driver: { select: { userId: true } } } });
      if (!offer) return;
      if (offer.response === null) {
        const r = await this.prisma.orderOffer.updateMany({ where: { id: offerId, response: null }, data: { response: 'missed', respondedAt: new Date() } });
        if (r.count === 0) return;
        this.realtime.toUser(offer.driver.userId, 'order.offer_revoked', { orderId, reason: 'timeout' });
      } else if (offer.response !== 'declined' && offer.response !== 'missed') {
        return;
      }
    }
    await this.offerNextAuto(orderId);
  }

  async radiusForRound(round: number): Promise<number> {
    const radii = await this.settings.get('order.dispatch_radius_m');
    return radii[Math.min(round - 1, radii.length - 1)];
  }

  /** Send offers for the order's current round to every eligible driver not yet offered. */
  async broadcast(orderId: string, round: number): Promise<number> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { package: true } });
    if (!order || order.status !== 'SEARCHING' || order.dispatchRound !== round) return 0;
    if (await this.autoAssign()) return (await this.offerNextAuto(orderId)) ? 1 : 0;
    const radius = await this.radiusForRound(round);
    const drivers = await this.geo.eligibleDrivers(order.id, order.deliveryLat, order.deliveryLng, radius);
    let sent = 0;
    for (const d of drivers) {
      try {
        const offer = await this.prisma.orderOffer.create({ data: { orderId, driverId: d.driverId, round, distanceM: d.distanceM } });
        sent++;
        await this.sendOffer(offer.id, d.userId, order, d.distanceM);
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue; // already offered
        throw err;
      }
    }
    logger.info({ orderId, round, radius, sent }, 'dispatch round broadcast');
    return sent;
  }

  /** Round timer fired. Idempotent: does nothing unless the order is still SEARCHING in this round. */
  async roundTimeout(orderId: string, round: number): Promise<void> {
    const effects = new AfterCommit();
    const extraRounds = await this.settings.get('order.rebroadcast_rounds');
    const windowSec = await this.transitions.roundWindowSec();
    let next: number | null = null;
    await this.prisma.tx(async (tx) => {
      const order = await this.transitions.lock(tx, orderId);
      if (order.status !== 'SEARCHING' || order.dispatchRound !== round) return;
      // A stale timer from an earlier search (e.g. before an admin reassign) must not cut this window short.
      if (order.expiresAt && order.expiresAt.getTime() > Date.now() + 2000) return;
      await tx.orderOffer.updateMany({ where: { orderId, round, response: null }, data: { response: 'missed', respondedAt: new Date() } });
      if (round < 1 + extraRounds) {
        next = round + 1;
        const expiresAt = new Date(Date.now() + windowSec * 1000);
        await tx.order.update({ where: { id: orderId }, data: { dispatchRound: next, expiresAt } });
        await tx.orderEvent.create({
          data: {
            orderId,
            fromStatus: 'SEARCHING',
            toStatus: 'SEARCHING',
            actorType: 'system',
            metadata: { rebroadcast: true, round: next, radiusM: await this.radiusForRound(next) },
          },
        });
        const r = next;
        effects.add(() => this.broadcast(orderId, r));
        effects.add(() =>
          this.jobs.enqueue('orders', 'dispatch.round_timeout', { orderId, round: r }, { delayMs: windowSec * 1000, jobId: `round-${orderId}-${r}-${expiresAt.getTime()}` }),
        );
      } else {
        await this.transitions.transition(tx, order, 'EXPIRED', { type: 'system', id: null }, effects, { reason: 'No driver accepted in time' });
      }
    });
    await effects.run();
  }

  /** When a driver comes online (or moves), offer them open orders already within the current round radius. */
  async offerOpenOrdersToDriver(driverId: string): Promise<void> {
    const driver = await this.prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver || !driver.online || driver.currentLat === null || driver.currentLng === null) return;
    const radii = await this.settings.get('order.dispatch_radius_m');
    const maxRadius = Math.max(...radii);
    const auto = await this.autoAssign();
    const candidates = await this.prisma.$queryRaw<{ id: string; dispatch_round: number; distance_m: number }[]>(Prisma.sql`
      SELECT o.id, o.dispatch_round,
             ST_Distance(ST_SetSRID(ST_MakePoint(o.delivery_lng, o.delivery_lat), 4326)::geography,
                         ST_SetSRID(ST_MakePoint(${driver.currentLng}, ${driver.currentLat}), 4326)::geography)::int AS distance_m
      FROM orders o
      WHERE o.status = 'SEARCHING'
        AND ST_DWithin(ST_SetSRID(ST_MakePoint(o.delivery_lng, o.delivery_lat), 4326)::geography,
                       ST_SetSRID(ST_MakePoint(${driver.currentLng}, ${driver.currentLat}), 4326)::geography, ${maxRadius})
        AND NOT EXISTS (SELECT 1 FROM order_offers oo WHERE oo.order_id = o.id AND oo.driver_id = ${driverId}::uuid)
      ORDER BY o.created_at ASC
      LIMIT 10`);
    for (const c of candidates) {
      const radius = await this.radiusForRound(c.dispatch_round);
      if (c.distance_m > radius) continue;
      if (auto) {
        // Only picks up orders nobody currently holds; the nearest eligible driver (maybe this one) gets it.
        await this.offerNextAuto(c.id);
        continue;
      }
      const eligible = await this.geo.eligibleDrivers(c.id, ...(await this.orderPoint(c.id)), radius);
      const me = eligible.find((e) => e.driverId === driverId);
      if (!me) continue;
      const order = await this.prisma.order.findUnique({ where: { id: c.id }, include: { package: true } });
      if (!order) continue;
      try {
        const offer = await this.prisma.orderOffer.create({ data: { orderId: c.id, driverId, round: c.dispatch_round, distanceM: me.distanceM } });
        await this.sendOffer(offer.id, driver.userId, order, me.distanceM);
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      }
    }
  }

  private async orderPoint(orderId: string): Promise<[number, number]> {
    const o = await this.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { deliveryLat: true, deliveryLng: true } });
    return [o.deliveryLat, o.deliveryLng];
  }

  private async sendOffer(
    offerId: string,
    driverUserId: string,
    order: { id: string; shortCode: string; priceToea: number; commissionToea: number; expiresAt: Date | null; quantity: number; deliveryAddress: string; deliveryNotes: string; deliveryLat: number; deliveryLng: number; package: { name: string; volumeLitres: number } },
    distanceM: number,
  ): Promise<void> {
    const earnings = order.priceToea - order.commissionToea;
    const payload = {
      offerId,
      orderId: order.id,
      shortCode: order.shortCode,
      package: order.package.name,
      volumeLitres: order.package.volumeLitres * order.quantity,
      quantity: order.quantity,
      distanceM,
      earningsToea: earnings,
      priceToea: order.priceToea,
      expiresAt: order.expiresAt,
      delivery: { lat: order.deliveryLat, lng: order.deliveryLng, address: order.deliveryAddress, notes: order.deliveryNotes },
    };
    this.realtime.toUser(driverUserId, 'order.offer', { offer: payload });
    await this.notifications.notify(driverUserId, 'driver.offer', {
      orderId: order.id,
      shortCode: order.shortCode,
      volume: payload.volumeLitres,
      distanceKm: (distanceM / 1000).toFixed(1),
      earnings: formatKina(earnings),
    });
  }
}
