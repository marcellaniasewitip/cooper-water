import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Errors } from '../common/errors';
import { normalisePhone } from '../common/phone';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';
import { NotificationsService } from './notifications.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { loadEnv } from '../config/env';

export type BroadcastAudience = 'drivers' | 'customers' | 'all' | 'user';

export interface BroadcastInput {
  audience: BroadcastAudience;
  /** Required when audience = user: the driver's or customer's phone number. */
  phone?: string;
  title: string;
  body: string;
}

/**
 * Admin push messages (Notifications → Push messages). Sends to all drivers, all customers, everyone, or one
 * person, and keeps a history. Recipients see the message as a push and in the app (customer Inbox, driver
 * Announcements). Suspended and deleted accounts are skipped.
 */
@Injectable()
export class BroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private recipientsWhere(audience: Exclude<BroadcastAudience, 'user'>): Prisma.UserWhereInput {
    const base: Prisma.UserWhereInput = { status: 'active', deletedAt: null };
    if (audience === 'drivers') return { ...base, role: 'driver' };
    if (audience === 'customers') return { ...base, role: 'customer' };
    return base;
  }

  /** How many people a message would reach (shown before sending). */
  async count(audience: BroadcastAudience, phone?: string): Promise<{ recipients: number; name?: string | null; role?: string; pushEnabled: boolean }> {
    // Without Firebase (PUSH_PROVIDER=fcm) messages still reach open/online apps live and every Inbox / Announcements.
    const pushEnabled = loadEnv().pushProvider === 'fcm';
    if (audience === 'user') {
      const u = await this.findUser(phone);
      return { recipients: 1, name: u.name, role: u.role, pushEnabled };
    }
    return { recipients: await this.prisma.user.count({ where: this.recipientsWhere(audience) }), pushEnabled };
  }

  async send(adminId: string, input: BroadcastInput, ip?: string) {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || !body) throw Errors.invalid('broadcast_empty', 'Enter a title and a message');

    let userIds: string[];
    let userId: string | null = null;
    if (input.audience === 'user') {
      const u = await this.findUser(input.phone);
      userIds = [u.id];
      userId = u.id;
    } else {
      const users = await this.prisma.user.findMany({ where: this.recipientsWhere(input.audience), select: { id: true } });
      userIds = users.map((u) => u.id);
    }
    if (userIds.length === 0) throw Errors.invalid('broadcast_no_recipients', 'Nobody matches this audience yet');

    const b = await this.prisma.broadcast.create({ data: { audience: input.audience, userId, title, body, createdBy: adminId } });
    const recipients = await this.notifications.sendBroadcast(userIds, { title, body, broadcastId: b.id });
    const saved = await this.prisma.broadcast.update({ where: { id: b.id }, data: { recipients } });
    // Live delivery: apps that are connected (drivers while online, customers with the app open) show it as a
    // phone notification straight away, even without Firebase push. Same broadcastId → no duplicate if push lands too.
    for (const id of userIds) this.realtime.toUser(id, 'notification.message', { broadcastId: b.id, title, body });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'broadcast.send', entity: 'broadcast', entityId: b.id, after: saved, ip });
    return this.view(saved);
  }

  /** Sent messages, newest first, with who sent them and push delivery counts. */
  async list(q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.broadcast.findMany({ where: cursorWhere(q.cursor), orderBy: pageOrder, take: limit + 1 });
    const page = toPage(rows, limit);
    const admins = await this.prisma.adminUser.findMany({ where: { id: { in: [...new Set(page.items.map((r) => r.createdBy))] } }, select: { id: true, name: true } });
    const users = await this.prisma.user.findMany({
      where: { id: { in: page.items.map((r) => r.userId).filter((x): x is string => !!x) } },
      select: { id: true, name: true, phone: true, role: true },
    });
    const items = [];
    for (const r of page.items) {
      const pushed = await this.prisma.notification.count({ where: { template: 'broadcast', status: 'sent', payload: { path: ['broadcastId'], equals: r.id } } });
      items.push({
        ...this.view(r),
        pushed,
        sentBy: admins.find((a) => a.id === r.createdBy)?.name ?? null,
        user: users.find((u) => u.id === r.userId) ?? null,
      });
    }
    return { items, nextCursor: page.nextCursor };
  }

  private view(b: { id: string; audience: string; userId: string | null; title: string; body: string; recipients: number; createdAt: Date }) {
    return { id: b.id, audience: b.audience, userId: b.userId, title: b.title, body: b.body, recipients: b.recipients, createdAt: b.createdAt };
  }

  private async findUser(phone?: string) {
    if (!phone) throw Errors.invalid('broadcast_phone_required', 'Enter the phone number of the driver or customer');
    const u = await this.prisma.user.findFirst({ where: { phone: normalisePhone(phone), deletedAt: null } });
    if (!u) throw Errors.notFound('Driver or customer with this phone number');
    if (u.status !== 'active') throw Errors.invalid('broadcast_user_suspended', 'This account is suspended');
    return u;
  }
}
