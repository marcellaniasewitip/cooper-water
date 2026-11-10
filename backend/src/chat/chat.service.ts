import { Injectable } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { Errors } from '../common/errors';

/** Chat is open from acceptance until the order is finished (DISPUTED keeps it open for the conversation). */
const CHAT_OPEN: OrderStatus[] = ['ACCEPTED', 'LOADING', 'EN_ROUTE', 'ARRIVED', 'DELIVERED', 'DISPUTED'];

export type ChatRole = 'customer' | 'driver';

/**
 * Per-order chat between the customer and the assigned driver (StarTrip style). Messages are kept
 * with the order so admins can read them when handling disputes.
 */
@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  private async participants(orderId: string, userId: string, role: ChatRole) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { driver: { include: { user: { select: { id: true, name: true } } } }, customer: { select: { id: true, name: true } } },
    });
    const isMine = order && (role === 'customer' ? order.customerId === userId : order.driver?.userId === userId);
    if (!order || !isMine) throw Errors.notFound('Order');
    if (!order.driver) throw Errors.conflict('chat_no_driver', 'You can chat once a driver has accepted the order');
    const other = role === 'customer' ? order.driver.user : order.customer;
    return { order, otherUserId: other.id, otherName: other.name ?? (role === 'customer' ? 'Driver' : 'Customer') };
  }

  async messages(orderId: string, userId: string, role: ChatRole) {
    const { order, otherName } = await this.participants(orderId, userId, role);
    await this.prisma.chatMessage.updateMany({ where: { orderId, senderId: { not: userId }, readAt: null }, data: { readAt: new Date() } });
    const rows = await this.prisma.chatMessage.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, take: 500 });
    return {
      orderId,
      shortCode: order.shortCode,
      otherName,
      open: CHAT_OPEN.includes(order.status),
      messages: rows.map((m) => ({ id: m.id, body: m.body, mine: m.senderId === userId, senderRole: m.senderRole, createdAt: m.createdAt, readAt: m.readAt })),
    };
  }

  async send(orderId: string, userId: string, role: ChatRole, bodyInput: string) {
    const body = bodyInput.trim();
    if (!body) throw Errors.invalid('chat_empty', 'Type a message');
    const { order, otherUserId } = await this.participants(orderId, userId, role);
    if (!CHAT_OPEN.includes(order.status)) throw Errors.conflict('chat_closed', 'This chat is closed because the order is finished');
    const m = await this.prisma.chatMessage.create({ data: { orderId, senderId: userId, senderRole: role, body: body.slice(0, 1000) } });
    const sender = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const view = { id: m.id, body: m.body, senderRole: role, createdAt: m.createdAt, readAt: null };
    this.realtime.toUser(otherUserId, 'chat.message', { orderId, shortCode: order.shortCode, message: { ...view, mine: false } });
    await this.notifications.notify(otherUserId, 'chat.message', {
      sender: sender?.name ?? (role === 'customer' ? 'Customer' : 'Driver'),
      shortCode: order.shortCode,
      preview: m.body.length > 80 ? `${m.body.slice(0, 77)}...` : m.body,
      orderId,
    });
    return { ...view, mine: true };
  }

  /** Chat list (StarTrip "Current" / "Past"): orders with a driver, newest activity first. */
  async conversations(userId: string, role: ChatRole) {
    const orders = await this.prisma.order.findMany({
      where: { driverId: { not: null }, ...(role === 'customer' ? { customerId: userId } : { driver: { userId } }) },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      include: {
        driver: { include: { user: { select: { name: true } } } },
        customer: { select: { name: true } },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        _count: { select: { messages: { where: { senderId: { not: userId }, readAt: null } } } },
      },
    });
    return orders
      .filter((o) => o.messages.length > 0 || CHAT_OPEN.includes(o.status))
      .map((o) => ({
        orderId: o.id,
        shortCode: o.shortCode,
        otherName: (role === 'customer' ? o.driver?.user?.name : o.customer?.name) ?? (role === 'customer' ? 'Driver' : 'Customer'),
        open: CHAT_OPEN.includes(o.status),
        lastMessage: o.messages[0] ? { body: o.messages[0].body, mine: o.messages[0].senderId === userId, createdAt: o.messages[0].createdAt } : null,
        unread: o._count.messages,
        updatedAt: o.messages[0]?.createdAt ?? o.updatedAt,
      }))
      .sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  }

  /** Admin: full transcript for disputes. */
  async transcript(orderId: string) {
    const rows = await this.prisma.chatMessage.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      include: { sender: { select: { name: true, phone: true } } },
    });
    return rows.map((m) => ({ id: m.id, body: m.body, senderRole: m.senderRole, senderName: m.sender.name, createdAt: m.createdAt, readAt: m.readAt }));
  }
}
