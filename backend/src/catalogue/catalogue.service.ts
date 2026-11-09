import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';

export interface DepotInput {
  name: string;
  lat: number;
  lng: number;
  geofenceRadiusM?: number | null;
  geofencePolygon?: { type: 'Polygon'; coordinates: number[][][] } | null;
  active?: boolean;
}

export interface PackageInput {
  name: string;
  volumeLitres: number;
  priceToea: number;
  active?: boolean;
  sortOrder?: number;
}

@Injectable()
export class CatalogueService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  activePackages() {
    return this.prisma.package.findMany({ where: { active: true, deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { volumeLitres: 'asc' }] });
  }

  allPackages() {
    return this.prisma.package.findMany({ where: { deletedAt: null }, orderBy: [{ sortOrder: 'asc' }, { volumeLitres: 'asc' }] });
  }

  activeDepots() {
    return this.prisma.depot.findMany({ where: { active: true, deletedAt: null }, orderBy: { name: 'asc' } });
  }

  allDepots() {
    return this.prisma.depot.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  }

  async createPackage(adminId: string, input: PackageInput, ip: string | null) {
    const pkg = await this.prisma.package.create({ data: input });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'package.create', entity: 'package', entityId: pkg.id, after: pkg, ip });
    return pkg;
  }

  async updatePackage(adminId: string, id: string, input: Partial<PackageInput>, ip: string | null) {
    const before = await this.prisma.package.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw Errors.notFound('Package');
    // Price changes only affect new orders: orders snapshot price at creation (§8.1).
    const after = await this.prisma.package.update({ where: { id }, data: input });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'package.update', entity: 'package', entityId: id, before, after, ip });
    return after;
  }

  async deletePackage(adminId: string, id: string, ip: string | null) {
    const before = await this.prisma.package.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw Errors.notFound('Package');
    await this.prisma.package.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'package.delete', entity: 'package', entityId: id, before, ip });
  }

  async createDepot(adminId: string, input: DepotInput, ip: string | null) {
    validatePolygon(input.geofencePolygon);
    const depot = await this.prisma.depot.create({ data: { ...input, geofencePolygon: input.geofencePolygon ?? Prisma.DbNull } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'depot.create', entity: 'depot', entityId: depot.id, after: depot, ip });
    return depot;
  }

  async updateDepot(adminId: string, id: string, input: Partial<DepotInput>, ip: string | null) {
    validatePolygon(input.geofencePolygon);
    const before = await this.prisma.depot.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw Errors.notFound('Depot');
    const data: any = { ...input };
    // Plain null would be stored as a JSON null, which reads as "has a polygon"; clear it to SQL NULL instead.
    if (input.geofencePolygon === null) data.geofencePolygon = Prisma.DbNull;
    const after = await this.prisma.depot.update({ where: { id }, data });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'depot.update', entity: 'depot', entityId: id, before, after, ip });
    return after;
  }

  async deleteDepot(adminId: string, id: string, ip: string | null) {
    const before = await this.prisma.depot.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw Errors.notFound('Depot');
    await this.prisma.depot.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'depot.delete', entity: 'depot', entityId: id, before, ip });
  }
}

/** GeoJSON Polygon: one closed ring of ≥4 [lng, lat] positions. */
function validatePolygon(p: DepotInput['geofencePolygon']): void {
  if (p === undefined || p === null) return;
  const ring = p?.coordinates?.[0];
  const ok =
    p.type === 'Polygon' &&
    Array.isArray(ring) &&
    ring.length >= 4 &&
    ring.every((c) => Array.isArray(c) && c.length === 2 && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90) &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  if (!ok) throw Errors.invalid('invalid_geofence', 'Geofence must be a closed GeoJSON Polygon ring of [lng, lat] points');
}
