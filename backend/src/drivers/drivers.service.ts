import { Injectable, OnModuleInit } from '@nestjs/common';
import { DriverStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { GeoService } from '../geo/geo.service';
import { StorageService } from '../storage/storage.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { LedgerService } from '../wallet/ledger.service';
import { DispatchService } from '../orders/dispatch.service';
import { logger } from '../common/logger';
import { Errors } from '../common/errors';
import { formatKina } from '../common/money';
import { isValidLatLng } from '../common/geo';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';
import { TRACKABLE_STATUSES } from '../orders/state-machine';

export const UPLOAD_FOLDERS = {
  document: 'driver-documents',
  topup_proof: 'topup-proofs',
  proof_of_delivery: 'proof-of-delivery',
  truck_photo: 'truck-photos',
} as const;

@Injectable()
export class DriversService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly geo: GeoService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
    private readonly ledger: LedgerService,
    private readonly dispatch: DispatchService,
  ) {}

  onModuleInit(): void {
    this.realtime.onDriverLocation = async (userId, lat, lng) => {
      const d = await this.prisma.driver.findUnique({ where: { userId } });
      if (d) await this.updateLocation(d.id, [{ lat, lng }]);
    };
  }

  async byUserId(userId: string) {
    const d = await this.prisma.driver.findUnique({ where: { userId } });
    if (!d) throw Errors.notFound('Driver profile');
    return d;
  }

  // ───────────── Onboarding ─────────────

  async profile(driverId: string) {
    const d = await this.prisma.driver.findUniqueOrThrow({
      where: { id: driverId },
      include: { user: true, documents: { orderBy: { createdAt: 'desc' } }, trucks: { where: { deletedAt: null } } },
    });
    const required = await this.settings.get('driver.required_documents');
    const latestByType = new Map<string, (typeof d.documents)[number]>();
    for (const doc of d.documents) if (!latestByType.has(doc.type)) latestByType.set(doc.type, doc);
    const wallet = await this.ledger.driverWallet(d.id);
    const min = await this.settings.get('wallet.min_balance_toea');
    return {
      id: d.id,
      name: d.user.name,
      phone: d.user.phone,
      status: d.status,
      rejectReason: d.rejectReason,
      online: d.online,
      ratingAvg: d.ratingAvg,
      ratingCount: d.ratingCount,
      truck: d.trucks[0] ? { id: d.trucks[0].id, plate: d.trucks[0].plate, capacityLitres: d.trucks[0].capacityLitres, photoKey: d.trucks[0].photoKey } : null,
      documents: required.map((type) => {
        const doc = latestByType.get(type);
        return { type, status: doc?.status ?? 'missing', notes: doc?.notes ?? null, uploadedAt: doc?.createdAt ?? null };
      }),
      wallet: { balanceToea: wallet.balanceToea, minBalanceToea: min, blocked: wallet.balanceToea < min },
      canGoOnline: d.status === 'approved' && wallet.balanceToea >= min,
    };
  }

  async presignUpload(driverId: string, purpose: keyof typeof UPLOAD_FOLDERS, contentType: string, contentLength: number) {
    return this.storage.presignUpload(UPLOAD_FOLDERS[purpose], driverId, contentType, contentLength);
  }

  async uploadDirect(driverId: string, purpose: string, contentType: string, body: Buffer, fallbackReason?: string) {
    if (!(purpose in UPLOAD_FOLDERS)) throw Errors.invalid('invalid_purpose', `purpose must be one of: ${Object.keys(UPLOAD_FOLDERS).join(', ')}`);
    // Logged so repeated presigned-upload failures (and their S3 error) are visible in CloudWatch.
    if (fallbackReason) logger.warn({ driverId, purpose, reason: fallbackReason.slice(0, 300) }, 'presigned upload failed; using direct upload');
    return this.storage.putObject(UPLOAD_FOLDERS[purpose as keyof typeof UPLOAD_FOLDERS], driverId, contentType, body);
  }

  async submitDocument(driverId: string, type: string, fileKey: string) {
    const required = await this.settings.get('driver.required_documents');
    if (!required.includes(type)) throw Errors.invalid('unknown_document_type', `Document type must be one of: ${required.join(', ')}`);
    this.storage.assertOwnedKey(fileKey, UPLOAD_FOLDERS.document, driverId);
    const doc = await this.prisma.driverDocument.create({ data: { driverId, type, fileKey } });
    await this.refreshOnboardingStatus(driverId);
    return doc;
  }

  async upsertTruck(driverId: string, dto: { plate: string; capacityLitres: number; photoKey?: string }) {
    if (dto.photoKey) this.storage.assertOwnedKey(dto.photoKey, UPLOAD_FOLDERS.truck_photo, driverId);
    const plate = dto.plate.toUpperCase().replace(/\s+/g, '');
    const existing = await this.prisma.truck.findFirst({ where: { driverId, deletedAt: null } });
    const truck = existing
      ? await this.prisma.truck.update({ where: { id: existing.id }, data: { plate, capacityLitres: dto.capacityLitres, photoKey: dto.photoKey ?? existing.photoKey } })
      : await this.prisma.truck.create({ data: { driverId, plate, capacityLitres: dto.capacityLitres, photoKey: dto.photoKey } });
    await this.refreshOnboardingStatus(driverId);
    return truck;
  }

  /** pending_docs → pending_approval once every required document and the truck are in. Rejected → back in review on re-submit. */
  private async refreshOnboardingStatus(driverId: string): Promise<void> {
    const d = await this.prisma.driver.findUniqueOrThrow({ where: { id: driverId }, include: { documents: true, trucks: { where: { deletedAt: null } } } });
    if (d.status !== 'pending_docs' && d.status !== 'rejected') return;
    const required = await this.settings.get('driver.required_documents');
    const have = new Set(d.documents.filter((x) => x.status !== 'rejected').map((x) => x.type));
    if (required.every((t) => have.has(t)) && d.trucks.length > 0) {
      await this.prisma.driver.update({ where: { id: driverId }, data: { status: 'pending_approval', rejectReason: null } });
    }
  }

  // ───────────── Availability & location (§7) ─────────────

  async goOnline(driverId: string, lat: number, lng: number) {
    const d = await this.prisma.driver.findUniqueOrThrow({ where: { id: driverId } });
    if (d.status !== 'approved') throw Errors.forbidden('Your account must be approved before you can go online');
    const [min, gated] = await Promise.all([this.settings.get('wallet.min_balance_toea'), this.settings.get('depot.online_gated')]);
    const wallet = await this.ledger.driverWallet(driverId);
    if (wallet.balanceToea < min) {
      throw Errors.conflict('wallet_below_minimum', `Top up your wallet to at least ${formatKina(min)} to go online`, {
        balanceToea: wallet.balanceToea,
        minBalanceToea: min,
      });
    }
    if (gated) {
      const depot = await this.geo.depotAt(lat, lng);
      if (!depot) throw Errors.invalid('not_at_depot', 'Go to a Cooper Waters depot to go online');
    }
    await this.prisma.driver.update({ where: { id: driverId }, data: { online: true, currentLat: lat, currentLng: lng, lastSeenAt: new Date() } });
    this.realtime.toAdmins('fleet.driver_location', { driverId, lat, lng, online: true });
    await this.dispatch.offerOpenOrdersToDriver(driverId);
    return this.profile(driverId);
  }

  async goOffline(driverId: string) {
    await this.prisma.driver.update({ where: { id: driverId }, data: { online: false } });
    this.realtime.toAdmins('fleet.driver_location', { driverId, online: false });
    return this.profile(driverId);
  }

  /** Batched points from the app (every 15–30 s while online); the newest wins. */
  async updateLocation(driverId: string, points: { lat: number; lng: number; at?: string }[]) {
    const valid = points.filter((p) => isValidLatLng(p.lat, p.lng));
    if (!valid.length) throw Errors.invalid('invalid_location', 'No valid location points');
    const latest = valid.reduce((a, b) => ((b.at ? Date.parse(b.at) : 0) >= (a.at ? Date.parse(a.at) : 0) ? b : a));
    const at = latest.at && Date.parse(latest.at) <= Date.now() ? new Date(latest.at) : new Date();
    const d = await this.prisma.driver.update({
      where: { id: driverId },
      data: { currentLat: latest.lat, currentLng: latest.lng, lastSeenAt: at },
    });
    this.realtime.toAdmins('fleet.driver_location', { driverId, lat: latest.lat, lng: latest.lng, online: d.online, at });
    const active = await this.prisma.order.findFirst({ where: { driverId, status: { in: TRACKABLE_STATUSES } }, select: { id: true, customerId: true } });
    if (active) {
      this.realtime.toUser(active.customerId, 'order.driver_location', { orderId: active.id, lat: latest.lat, lng: latest.lng, at });
    } else if (d.online) {
      await this.dispatch.offerOpenOrdersToDriver(driverId);
    }
    return { ok: true, online: d.online };
  }

  // ───────────── Admin ─────────────

  async adminList(q: CursorQuery & { status?: string; q?: string; online?: string }) {
    const limit = pageLimit(q);
    const where: Prisma.DriverWhereInput = {};
    if (q.status) where.status = { in: q.status.split(',') as DriverStatus[] };
    if (q.online !== undefined) where.online = q.online === 'true';
    if (q.q) where.OR = [{ user: { phone: { contains: q.q } } }, { user: { name: { contains: q.q, mode: 'insensitive' } } }, { trucks: { some: { plate: { contains: q.q.toUpperCase() } } } }];
    const rows = await this.prisma.driver.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { user: { select: { name: true, phone: true, status: true } }, trucks: { where: { deletedAt: null } } },
    });
    const walletRows = await this.prisma.wallet.findMany({ where: { ownerType: 'driver', ownerId: { in: rows.map((r) => r.id) } } });
    const balances = new Map(walletRows.map((w) => [w.ownerId, w.balanceToea]));
    const page = toPage(rows, limit);
    return {
      items: page.items.map((d) => ({
        id: d.id,
        createdAt: d.createdAt,
        userId: d.userId,
        name: d.user.name,
        phone: d.user.phone,
        accountStatus: d.user.status,
        status: d.status,
        online: d.online,
        lastSeenAt: d.lastSeenAt,
        location: d.currentLat !== null ? { lat: d.currentLat, lng: d.currentLng } : null,
        ratingAvg: d.ratingAvg,
        ratingCount: d.ratingCount,
        truck: d.trucks[0] ? { id: d.trucks[0].id, plate: d.trucks[0].plate, capacityLitres: d.trucks[0].capacityLitres } : null,
        balanceToea: balances.get(d.id) ?? 0,
      })),
      nextCursor: page.nextCursor,
    };
  }

  async adminGet(driverId: string) {
    const d = await this.prisma.driver.findUnique({
      where: { id: driverId },
      include: { user: true, documents: { orderBy: { createdAt: 'desc' } }, trucks: { where: { deletedAt: null } } },
    });
    if (!d) throw Errors.notFound('Driver');
    const wallet = await this.ledger.driverWallet(d.id);
    const documents = await Promise.all(
      d.documents.map(async (doc) => ({ ...doc, url: await this.storage.presignDownload(doc.fileKey).catch(() => null) })),
    );
    const trucks = await Promise.all(
      d.trucks.map(async (t) => ({ ...t, photoUrl: t.photoKey ? await this.storage.presignDownload(t.photoKey).catch(() => null) : null })),
    );
    const stats = await this.prisma.order.groupBy({ by: ['status'], where: { driverId }, _count: true });
    return {
      id: d.id,
      userId: d.userId,
      name: d.user.name,
      phone: d.user.phone,
      accountStatus: d.user.status,
      status: d.status,
      rejectReason: d.rejectReason,
      online: d.online,
      lastSeenAt: d.lastSeenAt,
      location: d.currentLat !== null ? { lat: d.currentLat, lng: d.currentLng } : null,
      ratingAvg: d.ratingAvg,
      ratingCount: d.ratingCount,
      createdAt: d.createdAt,
      wallet: { id: wallet.id, balanceToea: wallet.balanceToea },
      documents,
      trucks,
      orderCounts: Object.fromEntries(stats.map((s) => [s.status, s._count])),
    };
  }

  async reviewDocument(adminId: string, documentId: string, status: 'approved' | 'rejected', notes: string | undefined, ip: string | null) {
    const before = await this.prisma.driverDocument.findUnique({ where: { id: documentId }, include: { driver: true } });
    if (!before) throw Errors.notFound('Document');
    if (status === 'rejected' && !notes) throw Errors.invalid('notes_required', 'Say why the document is rejected');
    const after = await this.prisma.driverDocument.update({ where: { id: documentId }, data: { status, notes, reviewerId: adminId, reviewedAt: new Date() } });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: `driver_document.${status}`, entity: 'driver_document', entityId: documentId, before, after, ip });
    if (status === 'rejected') {
      await this.notifications.notify(before.driver.userId, 'driver.document_rejected', { type: before.type.replace(/_/g, ' '), reason: notes ?? '' });
    }
    return after;
  }

  async setStatus(adminId: string, driverId: string, action: 'approve' | 'reject' | 'suspend' | 'reinstate', reason: string | undefined, ip: string | null) {
    const d = await this.prisma.driver.findUnique({ where: { id: driverId }, include: { documents: true, trucks: { where: { deletedAt: null } } } });
    if (!d) throw Errors.notFound('Driver');
    let status: DriverStatus;
    if (action === 'approve') {
      const required = await this.settings.get('driver.required_documents');
      const approved = new Set(d.documents.filter((x) => x.status === 'approved').map((x) => x.type));
      const missing = required.filter((t) => !approved.has(t));
      if (missing.length) throw Errors.invalid('documents_not_approved', `Approve these documents first: ${missing.join(', ')}`, { missing });
      if (!d.trucks.length) throw Errors.invalid('truck_required', 'The driver has not registered a truck');
      status = 'approved';
    } else if (action === 'reject') {
      if (!reason) throw Errors.invalid('reason_required', 'Give a reason');
      status = 'rejected';
    } else if (action === 'suspend') {
      if (!reason) throw Errors.invalid('reason_required', 'Give a reason');
      status = 'suspended';
    } else {
      if (d.status !== 'suspended') throw Errors.conflict('not_suspended', 'Only suspended drivers can be reinstated');
      status = 'approved';
    }
    const after = await this.prisma.driver.update({
      where: { id: driverId },
      data: { status, rejectReason: action === 'reject' || action === 'suspend' ? reason : null, online: status === 'approved' ? d.online : false },
    });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: `driver.${action}`, entity: 'driver', entityId: driverId, before: d, after, ip });
    if (action === 'approve' || action === 'reinstate') await this.notifications.notify(d.userId, 'driver.approved');
    if (action === 'reject') await this.notifications.notify(d.userId, 'driver.rejected', { reason });
    return after;
  }

  /** Live fleet map (§10). */
  async fleet() {
    const staleSec = await this.settings.get('driver.location_stale_sec');
    const drivers = await this.prisma.driver.findMany({
      where: { status: 'approved', currentLat: { not: null } },
      include: { user: { select: { name: true, phone: true } }, trucks: { where: { deletedAt: null }, take: 1 } },
    });
    const active = await this.prisma.order.findMany({
      where: { driverId: { in: drivers.map((d) => d.id) }, status: { in: TRACKABLE_STATUSES } },
      select: { id: true, shortCode: true, status: true, driverId: true, deliveryLat: true, deliveryLng: true },
    });
    const byDriver = new Map(active.map((o) => [o.driverId, o]));
    return drivers.map((d) => ({
      driverId: d.id,
      name: d.user.name,
      phone: d.user.phone,
      plate: d.trucks[0]?.plate ?? null,
      online: d.online,
      stale: !d.lastSeenAt || Date.now() - d.lastSeenAt.getTime() > staleSec * 1000,
      lat: d.currentLat,
      lng: d.currentLng,
      lastSeenAt: d.lastSeenAt,
      activeOrder: byDriver.get(d.id) ?? null,
    }));
  }
}
