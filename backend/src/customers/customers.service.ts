import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokensService } from '../auth/tokens.service';
import { Errors } from '../common/errors';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';

export interface LocationInput {
  label: string;
  addressText: string;
  lat: number;
  lng: number;
  landmarkNotes?: string;
}

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tokens: TokensService,
  ) {}

  async me(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { id: u.id, phone: u.phone, name: u.name, role: u.role, createdAt: u.createdAt };
  }

  async updateProfile(userId: string, name: string) {
    const u = await this.prisma.user.update({ where: { id: userId }, data: { name: name.trim() } });
    return { id: u.id, phone: u.phone, name: u.name, role: u.role };
  }

  async setPushToken(userId: string, token: string | null) {
    await this.prisma.user.update({ where: { id: userId }, data: { fcmToken: token } });
  }

  locations(userId: string) {
    return this.prisma.customerLocation.findMany({ where: { userId, deletedAt: null }, orderBy: { createdAt: 'desc' } });
  }

  addLocation(userId: string, input: LocationInput) {
    return this.prisma.customerLocation.create({ data: { ...input, landmarkNotes: input.landmarkNotes ?? '', userId } });
  }

  async updateLocation(userId: string, id: string, input: Partial<LocationInput>) {
    const l = await this.prisma.customerLocation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!l) throw Errors.notFound('Location');
    return this.prisma.customerLocation.update({ where: { id }, data: input });
  }

  async deleteLocation(userId: string, id: string) {
    const l = await this.prisma.customerLocation.findFirst({ where: { id, userId, deletedAt: null } });
    if (!l) throw Errors.notFound('Location');
    await this.prisma.customerLocation.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  // ───────────── Admin ─────────────

  async adminList(q: CursorQuery & { q?: string; status?: string }) {
    const limit = pageLimit(q);
    const where: Prisma.UserWhereInput = { role: 'customer', deletedAt: null };
    if (q.status === 'active' || q.status === 'suspended') where.status = q.status;
    if (q.q) where.OR = [{ phone: { contains: q.q } }, { name: { contains: q.q, mode: 'insensitive' } }];
    const rows = await this.prisma.user.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { _count: { select: { customerOrders: true } } },
    });
    const page = toPage(rows, limit);
    return {
      items: page.items.map((u) => ({ id: u.id, phone: u.phone, name: u.name, status: u.status, createdAt: u.createdAt, orderCount: u._count.customerOrders })),
      nextCursor: page.nextCursor,
    };
  }

  async adminGet(id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, role: 'customer' }, include: { locations: { where: { deletedAt: null } } } });
    if (!u) throw Errors.notFound('Customer');
    const stats = await this.prisma.order.groupBy({ by: ['status'], where: { customerId: id }, _count: true });
    // Customer wallet (created on first use), so admins can see the balance and top up / deduct.
    const wallet = await this.prisma.wallet.upsert({
      where: { ownerType_ownerId: { ownerType: 'customer', ownerId: id } },
      create: { ownerType: 'customer', ownerId: id },
      update: {},
    });
    return {
      id: u.id,
      phone: u.phone,
      name: u.name,
      status: u.status,
      createdAt: u.createdAt,
      phoneVerifiedAt: u.phoneVerifiedAt,
      locations: u.locations,
      orderCounts: Object.fromEntries(stats.map((s) => [s.status, s._count])),
      wallet: { id: wallet.id, balanceToea: wallet.balanceToea },
    };
  }

  async adminSetStatus(adminId: string, id: string, status: 'active' | 'suspended', ip: string | null) {
    const before = await this.prisma.user.findFirst({ where: { id, role: 'customer' } });
    if (!before) throw Errors.notFound('Customer');
    const after = await this.prisma.user.update({ where: { id }, data: { status } });
    if (status === 'suspended') await this.tokens.revokeAll(id);
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: `customer.${status === 'active' ? 'reactivate' : 'suspend'}`, entity: 'user', entityId: id, before, after, ip });
    return { id: after.id, status: after.status };
  }
}
