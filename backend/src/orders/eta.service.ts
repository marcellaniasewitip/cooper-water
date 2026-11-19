import { Injectable } from '@nestjs/common';
import { Order } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { MapsService, LatLng } from '../geo/maps.service';

export interface Eta {
  orderId: string;
  status: string;
  /** Seconds until the driver reaches the customer (null when there is no driver or no location yet). */
  etaSec: number | null;
  /** Road distance still to drive, metres (through the depot while the water isn't loaded yet). */
  distanceM: number | null;
  /** Expected arrival time (ISO). */
  arriveAt: string | null;
  /** The driver still has to load at a depot first. */
  viaDepot: boolean;
  depotName: string | null;
  /** google = road route with live traffic; estimate = straight-line distance at town speeds. */
  source: 'google' | 'estimate' | null;
  arrived: boolean;
  computedAt: string;
}

/** Town driving: roads are ~1.4× the straight line, ~30 km/h average in Port Moresby traffic. */
const ROAD_FACTOR = 1.4;
const TOWN_SPEED_MPS = 30_000 / 3600;

export function haversineM(a: LatLng, b: LatLng): number {
  const r = 6_371_000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/**
 * How long until the driver reaches the customer, along the route they actually drive:
 * ACCEPTED → driver → nearest depot (load) → customer; LOADING → finish loading → customer;
 * EN_ROUTE → driver → customer; ARRIVED → 0.
 */
@Injectable()
export class EtaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly maps: MapsService,
  ) {}

  async forOrder(order: Order): Promise<Eta> {
    const now = new Date();
    const base: Eta = { orderId: order.id, status: order.status, etaSec: null, distanceM: null, arriveAt: null, viaDepot: false, depotName: null, source: null, arrived: false, computedAt: now.toISOString() };
    if (order.status === 'ARRIVED') return { ...base, etaSec: 0, distanceM: 0, arriveAt: now.toISOString(), arrived: true };
    if (!['ACCEPTED', 'LOADING', 'EN_ROUTE'].includes(order.status) || !order.driverId) return base;
    const driver = await this.prisma.driver.findUnique({ where: { id: order.driverId }, select: { currentLat: true, currentLng: true } });
    if (driver?.currentLat == null || driver.currentLng == null) return base;

    const from: LatLng = { lat: driver.currentLat, lng: driver.currentLng };
    const to: LatLng = { lat: order.deliveryLat, lng: order.deliveryLng };
    const loadingSec = Number(await this.settings.get('eta.loading_sec'));
    let points: LatLng[] = [from, to];
    let extraSec = 0;
    let depotName: string | null = null;
    if (order.status === 'ACCEPTED') {
      const depots = await this.prisma.depot.findMany({ where: { active: true }, select: { name: true, lat: true, lng: true } });
      const depot = depots.sort((a, b) => haversineM(from, a) - haversineM(from, b))[0];
      if (depot) {
        points = [from, { lat: depot.lat, lng: depot.lng }, to];
        depotName = depot.name;
      }
      extraSec = loadingSec;
    } else if (order.status === 'LOADING') {
      // Filling the tank: assume half the loading time is left.
      extraSec = Math.round(loadingSec / 2);
    }

    const road = await this.maps.route(points);
    let driveSec: number;
    let distanceM: number;
    if (road) {
      driveSec = road.durationSec;
      distanceM = road.distanceM;
    } else {
      distanceM = Math.round(points.slice(1).reduce((sum, p, i) => sum + haversineM(points[i], p), 0) * ROAD_FACTOR);
      driveSec = Math.round(distanceM / TOWN_SPEED_MPS);
    }
    const etaSec = driveSec + extraSec;
    return {
      ...base,
      etaSec,
      distanceM,
      arriveAt: new Date(now.getTime() + etaSec * 1000).toISOString(),
      viaDepot: order.status === 'ACCEPTED' && depotName !== null,
      depotName,
      source: road ? 'google' : 'estimate',
    };
  }

  async forCustomer(customerId: string, orderId: string): Promise<Eta | null> {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    return o && o.customerId === customerId ? this.forOrder(o) : null;
  }

  async forDriver(driverId: string, orderId: string): Promise<Eta | null> {
    const o = await this.prisma.order.findUnique({ where: { id: orderId } });
    return o && o.driverId === driverId ? this.forOrder(o) : null;
  }
}
