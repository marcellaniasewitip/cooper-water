import { Global, Injectable, Module } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

export interface DepotHit {
  id: string;
  name: string;
  distanceM: number;
}

export interface EligibleDriver {
  driverId: string;
  userId: string;
  distanceM: number;
}

/** PostGIS queries: depot geofences and dispatch radius (§7). */
@Injectable()
export class GeoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** The depot whose geofence contains the point, if any (polygon if set, else point + radius). */
  async depotAt(lat: number, lng: number, db: Tx | PrismaService = this.prisma): Promise<DepotHit | null> {
    const defaultRadius = await this.settings.get('depot.geofence_radius_m');
    const rows = await db.$queryRaw<DepotHit[]>(Prisma.sql`
      SELECT d.id, d.name,
             ST_Distance(ST_SetSRID(ST_MakePoint(d.lng, d.lat), 4326)::geography,
                         ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)::int AS "distanceM"
      FROM depots d
      WHERE d.active AND d.deleted_at IS NULL
        AND CASE
          -- jsonb_typeof guards against a JSON null stored instead of SQL NULL (it would crash ST_GeomFromGeoJSON).
          WHEN jsonb_typeof(d.geofence_polygon) = 'object' THEN
            ST_Covers(ST_SetSRID(ST_GeomFromGeoJSON(d.geofence_polygon::text), 4326)::geography,
                      ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)
          ELSE
            ST_DWithin(ST_SetSRID(ST_MakePoint(d.lng, d.lat), 4326)::geography,
                       ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
                       COALESCE(d.geofence_radius_m, ${defaultRadius}))
        END
      ORDER BY "distanceM" ASC
      LIMIT 1`);
    return rows[0] ?? null;
  }

  /**
   * Eligible drivers for an order (§7.1): approved, online, fresh location, wallet ≥ minimum,
   * no active order (when one-active-order is on), within radius, not already offered this order.
   */
  async eligibleDrivers(orderId: string, lat: number, lng: number, radiusM: number, db: Tx | PrismaService = this.prisma): Promise<EligibleDriver[]> {
    const [minBalance, staleSec, oneActive] = await Promise.all([
      this.settings.get('wallet.min_balance_toea'),
      this.settings.get('driver.location_stale_sec'),
      this.settings.get('order.one_active_per_driver'),
    ]);
    const activeStatuses = Prisma.sql`('ACCEPTED','LOADING','EN_ROUTE','ARRIVED')`;
    return db.$queryRaw<EligibleDriver[]>(Prisma.sql`
      SELECT dr.id AS "driverId", dr.user_id AS "userId",
             ST_Distance(ST_SetSRID(ST_MakePoint(dr.current_lng, dr.current_lat), 4326)::geography,
                         ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)::int AS "distanceM"
      FROM drivers dr
      JOIN users u ON u.id = dr.user_id AND u.status = 'active' AND u.deleted_at IS NULL
      JOIN wallets w ON w.owner_type = 'driver' AND w.owner_id = dr.id
      WHERE dr.status = 'approved'
        AND dr.online
        AND dr.current_lat IS NOT NULL AND dr.current_lng IS NOT NULL
        AND dr.last_seen_at > now() - make_interval(secs => ${staleSec})
        AND w.balance_toea >= ${minBalance}
        AND ST_DWithin(ST_SetSRID(ST_MakePoint(dr.current_lng, dr.current_lat), 4326)::geography,
                       ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, ${radiusM})
        AND (${!oneActive} OR NOT EXISTS (
              SELECT 1 FROM orders o WHERE o.driver_id = dr.id AND o.status IN ${activeStatuses}))
        AND NOT EXISTS (SELECT 1 FROM order_offers oo WHERE oo.order_id = ${orderId}::uuid AND oo.driver_id = dr.id)
      ORDER BY "distanceM" ASC
      LIMIT 50`);
  }
}

@Global()
@Module({ providers: [GeoService], exports: [GeoService] })
export class GeoModule {}
