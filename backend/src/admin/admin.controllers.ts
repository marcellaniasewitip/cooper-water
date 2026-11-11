import { Body, Controller, Delete, Get, Header, HttpCode, Ip, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { CurrentAdmin, RequirePermissions } from '../auth/decorators';
import { AdminPrincipal } from '../auth/auth.types';
import { Idempotent, IdempotencyKey } from '../common/idempotency';
import { CursorQuery, cursorWhere, pageLimit, pageOrder, toPage } from '../common/pagination';
import { Errors } from '../common/errors';
import { startOfBusinessDay } from '../common/time';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { BROADCAST_TEMPLATE, NotificationsService } from '../notifications/notifications.service';
import { BroadcastsService } from '../notifications/broadcasts.service';
import { OrdersService } from '../orders/orders.service';
import { DriversService } from '../drivers/drivers.service';
import { CustomersService } from '../customers/customers.service';
import { CatalogueService } from '../catalogue/catalogue.service';
import { WalletService } from '../wallet/wallet.service';
import { PromosService } from '../promos/promos.service';
import { ChatService } from '../chat/chat.service';
import { LedgerService } from '../wallet/ledger.service';
import { PaymentsService } from '../payments/payments.service';
import { RefundsService } from '../payments/refunds.service';
import { PaymentProvidersRegistry } from '../payments/providers.registry';
import { DisputesService } from '../disputes/disputes.service';
import { ReportsService } from '../reports/reports.service';
import { OrderTransitionsService } from '../orders/transitions.service';
import { AfterCommit } from '../common/after-commit';
import { AdminUsersService } from './admin-users.service';
import { AdminOrdersQuery, CancelDto, ReassignDto } from '../orders/orders.dto';
import {
  BroadcastCountQuery,
  BroadcastDto,
  PromoDto,
  UpdatePromoDto,
  AdjustmentDto,
  AuditQuery,
  CompleteRefundDto,
  ConfirmPaymentDto,
  CreateAdminDto,
  DepotDto,
  IssueRefundDto,
  ListQuery,
  OptionalReasonDto,
  PackageDto,
  PaymentsQuery,
  PayoutActionDto,
  RangeQuery,
  ReasonDto,
  ResolveDisputeDto,
  ReviewDocumentDto,
  RoleDto,
  SettingValueDto,
  TemplateDto,
  TruckUpdateDto,
  UpdateAdminDto,
  UpdateDepotDto,
  UpdatePackageDto,
} from './admin.dto';

function range(q: RangeQuery): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(startOfBusinessDay().getTime() - 29 * 24 * 3600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw Errors.badRequest('invalid_range', 'Invalid date range');
  if (to.getTime() - from.getTime() > 400 * 24 * 3600_000) throw Errors.badRequest('range_too_large', 'Choose a range of at most 400 days');
  return { from, to };
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminDashboardController {
  constructor(
    private readonly reports: ReportsService,
    private readonly drivers: DriversService,
  ) {}

  @Get('overview')
  @RequirePermissions('dashboard.view')
  overview() {
    return this.reports.overview();
  }

  @Get('fleet')
  @RequirePermissions('dashboard.view')
  fleet() {
    return this.drivers.fleet();
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsService,
    private readonly transitions: OrderTransitionsService,
    private readonly audit: AuditService,
    private readonly chat: ChatService,
  ) {}

  @Get()
  @RequirePermissions('orders.view')
  list(@Query() q: AdminOrdersQuery) {
    return this.orders.adminList(q);
  }

  @Get(':id')
  @RequirePermissions('orders.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.adminGet(id);
  }

  /** Customer ↔ driver chat transcript (for disputes). */
  @Get(':id/messages')
  @RequirePermissions('orders.view')
  messages(@Param('id', ParseUUIDPipe) id: string) {
    return this.chat.transcript(id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  async cancel(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto, @Ip() ip: string) {
    await this.orders.adminCancel(a.id, id, dto.reason, ip);
    return this.orders.adminGet(id);
  }

  @Post(':id/reassign')
  @HttpCode(200)
  @RequirePermissions('orders.manage')
  async reassign(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReassignDto, @Ip() ip: string) {
    await this.orders.adminReassign(a.id, id, dto.driverId, dto.reason, ip);
    return this.orders.adminGet(id);
  }

  /** Issue a refund for a paid cell money order outside a dispute (e.g. goodwill). */
  @Post(':id/refund')
  @HttpCode(200)
  @RequirePermissions('payments.refund')
  async refund(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: IssueRefundDto, @Ip() ip: string) {
    const effects = new AfterCommit();
    const refund = await this.prisma.tx(async (tx) => {
      const order = await this.transitions.lock(tx, id);
      if (order.paymentStatus !== 'paid') throw Errors.conflict('not_paid', 'Only orders paid by cell money can be refunded here');
      const r = await this.refunds.refundOrderPayment(tx, order, effects, { amountToea: dto.amountToea, reason: dto.reason });
      if (!r) throw Errors.conflict('no_payment', 'No successful payment found for this order');
      await this.audit.log({ actorId: a.id, actorType: 'admin', action: 'order.refund', entity: 'order', entityId: id, after: r, ip }, tx);
      return r;
    });
    await effects.run();
    return refund;
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customers.view')
  list(@Query() q: ListQuery) {
    return this.customers.adminList(q);
  }

  @Get(':id')
  @RequirePermissions('customers.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.adminGet(id);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  suspend(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.customers.adminSetStatus(a.id, id, 'suspended', ip);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermissions('customers.manage')
  reactivate(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.customers.adminSetStatus(a.id, id, 'active', ip);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/drivers')
export class AdminDriversController {
  constructor(
    private readonly drivers: DriversService,
    private readonly wallet: WalletService,
    private readonly ledger: LedgerService,
  ) {}

  @Get()
  @RequirePermissions('drivers.view')
  list(@Query() q: ListQuery) {
    return this.drivers.adminList(q);
  }

  @Get(':id')
  @RequirePermissions('drivers.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.drivers.adminGet(id);
  }

  @Post(':id/:action(approve|reject|suspend|reinstate)')
  @HttpCode(200)
  @RequirePermissions('drivers.approve')
  setStatus(
    @CurrentAdmin() a: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'approve' | 'reject' | 'suspend' | 'reinstate',
    @Body() dto: OptionalReasonDto,
    @Ip() ip: string,
  ) {
    return this.drivers.setStatus(a.id, id, action, dto.reason, ip);
  }

  @Post('documents/:docId/review')
  @HttpCode(200)
  @RequirePermissions('drivers.approve')
  review(@CurrentAdmin() a: AdminPrincipal, @Param('docId', ParseUUIDPipe) docId: string, @Body() dto: ReviewDocumentDto, @Ip() ip: string) {
    return this.drivers.reviewDocument(a.id, docId, dto.status, dto.notes, ip);
  }

  @Get(':id/wallet')
  @RequirePermissions('wallet.view')
  walletSummary(@Param('id', ParseUUIDPipe) id: string) {
    return this.wallet.summary(id);
  }

  @Get(':id/wallet/entries')
  @RequirePermissions('wallet.view')
  async walletEntries(@Param('id', ParseUUIDPipe) id: string, @Query() q: CursorQuery) {
    const w = await this.ledger.driverWallet(id);
    return this.wallet.entries(w.id, q);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/trucks')
export class AdminTrucksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('trucks.manage')
  async list(@Query() q: ListQuery) {
    const limit = pageLimit(q);
    const where: Prisma.TruckWhereInput = { deletedAt: null, ...(q.q ? { plate: { contains: q.q.toUpperCase() } } : {}) };
    const rows = await this.prisma.truck.findMany({
      where: { AND: [where, cursorWhere(q.cursor)] },
      orderBy: pageOrder,
      take: limit + 1,
      include: { driver: { include: { user: { select: { name: true, phone: true } } } } },
    });
    return toPage(rows, limit);
  }

  @Patch(':id')
  @RequirePermissions('trucks.manage')
  async update(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: TruckUpdateDto, @Ip() ip: string) {
    const before = await this.prisma.truck.findFirst({ where: { id, deletedAt: null } });
    if (!before) throw Errors.notFound('Truck');
    const after = await this.prisma.truck.update({ where: { id }, data: { ...dto, plate: dto.plate?.toUpperCase().replace(/\s+/g, '') } });
    await this.audit.log({ actorId: a.id, actorType: 'admin', action: 'truck.update', entity: 'truck', entityId: id, before, after, ip });
    return after;
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminCatalogueController {
  constructor(
    private readonly catalogue: CatalogueService,
    private readonly settings: SettingsService,
    private readonly promos: PromosService,
  ) {}

  // Offers / promo codes
  @Get('promos')
  @RequirePermissions('orders.view')
  promoList() {
    return this.promos.list();
  }

  @Post('promos')
  @RequirePermissions('pricing.edit')
  createPromo(@CurrentAdmin() a: AdminPrincipal, @Body() dto: PromoDto, @Ip() ip: string) {
    return this.promos.create(a.id, dto, ip);
  }

  @Patch('promos/:id')
  @RequirePermissions('pricing.edit')
  updatePromo(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromoDto, @Ip() ip: string) {
    return this.promos.update(a.id, id, dto, ip);
  }

  @Get('depots')
  @RequirePermissions('dashboard.view')
  depots() {
    return this.catalogue.allDepots();
  }

  @Post('depots')
  @RequirePermissions('depots.manage')
  createDepot(@CurrentAdmin() a: AdminPrincipal, @Body() dto: DepotDto, @Ip() ip: string) {
    return this.catalogue.createDepot(a.id, dto, ip);
  }

  @Patch('depots/:id')
  @RequirePermissions('depots.manage')
  updateDepot(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDepotDto, @Ip() ip: string) {
    return this.catalogue.updateDepot(a.id, id, dto, ip);
  }

  @Delete('depots/:id')
  @HttpCode(204)
  @RequirePermissions('depots.manage')
  async deleteDepot(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    await this.catalogue.deleteDepot(a.id, id, ip);
  }

  @Get('packages')
  @RequirePermissions('orders.view')
  packages() {
    return this.catalogue.allPackages();
  }

  @Post('packages')
  @RequirePermissions('pricing.edit')
  createPackage(@CurrentAdmin() a: AdminPrincipal, @Body() dto: PackageDto, @Ip() ip: string) {
    return this.catalogue.createPackage(a.id, dto, ip);
  }

  @Patch('packages/:id')
  @RequirePermissions('pricing.edit')
  updatePackage(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePackageDto, @Ip() ip: string) {
    return this.catalogue.updatePackage(a.id, id, dto, ip);
  }

  @Delete('packages/:id')
  @HttpCode(204)
  @RequirePermissions('pricing.edit')
  async deletePackage(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    await this.catalogue.deletePackage(a.id, id, ip);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly registry: PaymentProvidersRegistry,
  ) {}

  @Get()
  @RequirePermissions('settings.edit')
  all() {
    return this.settings.getAll();
  }

  @Put(':key')
  @RequirePermissions('settings.edit')
  async set(@CurrentAdmin() a: AdminPrincipal, @Param('key') key: string, @Body() dto: SettingValueDto, @Ip() ip: string) {
    if (key === 'payment.cellmoney.adapter' && !this.registry.names().includes(String(dto.value))) {
      throw Errors.invalid('unknown_adapter', `Adapter must be one of: ${this.registry.names().join(', ')}`);
    }
    const before = (await this.settings.getAll())[key];
    await this.settings.set(key, dto.value, a.id);
    await this.audit.log({ actorId: a.id, actorType: 'admin', action: 'setting.update', entity: 'setting', entityId: key, before: before?.value, after: dto.value, ip });
    return { key, value: dto.value };
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminMoneyController {
  constructor(
    private readonly wallet: WalletService,
    private readonly ledger: LedgerService,
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
    private readonly prisma: PrismaService,
  ) {}

  // Top-up approval queue (§8.5)
  @Get('topups')
  @RequirePermissions('wallet.view')
  topups(@Query() q: ListQuery) {
    return this.wallet.listTopups(q.status ? { status: { in: q.status.split(',') as any } } : {}, q);
  }

  @Post('topups/:id/approve')
  @HttpCode(200)
  @RequirePermissions('wallet.approve_topup')
  approveTopup(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.wallet.approveTopup(a.id, id, ip);
  }

  @Post('topups/:id/reject')
  @HttpCode(200)
  @RequirePermissions('wallet.approve_topup')
  rejectTopup(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Ip() ip: string) {
    return this.wallet.rejectTopup(a.id, id, dto.reason, ip);
  }

  @Get('wallets/platform')
  @RequirePermissions('wallet.view')
  async platformWallet(@Query() q: CursorQuery) {
    const w = await this.ledger.platformWallet();
    return { wallet: w, entries: await this.wallet.entries(w.id, q) };
  }

  @Get('wallets/:walletId/entries')
  @RequirePermissions('wallet.view')
  entries(@Param('walletId', ParseUUIDPipe) walletId: string, @Query() q: CursorQuery) {
    return this.wallet.entries(walletId, q);
  }

  @Post('wallets/:walletId/adjustments')
  @Idempotent()
  @RequirePermissions('wallet.adjust')
  adjust(@CurrentAdmin() a: AdminPrincipal, @Param('walletId', ParseUUIDPipe) walletId: string, @Body() dto: AdjustmentDto, @IdempotencyKey() key: string, @Ip() ip: string) {
    if (dto.amountToea === 0) throw Errors.invalid('zero_amount', 'Amount cannot be zero');
    return this.wallet.adjust(a.id, walletId, dto.amountToea, dto.reason, key, ip);
  }

  // Cell money transactions & reconciliation (§10)
  @Get('payments')
  @RequirePermissions('payments.view')
  list(@Query() q: PaymentsQuery) {
    const where: Prisma.PaymentWhereInput = {};
    if (q.status) where.status = { in: q.status.split(',') as any };
    if (q.purpose) where.purpose = q.purpose;
    if (q.adapter) where.adapter = q.adapter;
    if (q.q) where.OR = [{ reference: { contains: q.q.toUpperCase() } }, { msisdn: { contains: q.q } }, { providerRef: { contains: q.q } }];
    return this.payments.list(where, q);
  }

  @Get('payments/:id')
  @RequirePermissions('payments.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const p = await this.prisma.payment.findUnique({ where: { id } });
    if (!p) throw Errors.notFound('Payment');
    return p;
  }

  @Post('payments/:id/confirm')
  @HttpCode(200)
  @RequirePermissions('payments.confirm')
  confirm(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmPaymentDto, @Ip() ip: string) {
    return this.payments.adminConfirm(a.id, id, dto.receiptRef, ip);
  }

  @Post('payments/:id/fail')
  @HttpCode(200)
  @RequirePermissions('payments.confirm')
  fail(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @Ip() ip: string) {
    return this.payments.adminMarkFailed(a.id, id, dto.reason, ip);
  }

  @Post('payments/:id/recheck')
  @HttpCode(200)
  @RequirePermissions('payments.confirm')
  recheck(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.payments.adminRecheck(a.id, id);
  }

  @Post('payments/:id/complete-refund')
  @HttpCode(204)
  @RequirePermissions('payments.refund')
  async completeRefund(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteRefundDto) {
    await this.refunds.complete(id, dto.externalRef, a.id);
  }

  @Post('payments/:id/retry-refund')
  @HttpCode(204)
  @RequirePermissions('payments.refund')
  async retryRefund(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.refunds.retry(id, a.id);
  }

  @Get('webhook-events')
  @RequirePermissions('payments.view')
  async webhooks(@Query() q: CursorQuery) {
    const limit = pageLimit(q);
    const rows = await this.prisma.webhookEvent.findMany({ where: cursorWhere(q.cursor), orderBy: pageOrder, take: limit + 1 });
    return toPage(rows, limit);
  }

  // Payouts (manual, §8.3)
  @Get('payouts')
  @RequirePermissions('payouts.process')
  payouts(@Query() q: ListQuery) {
    return this.wallet.listPayouts(q.status ? { status: { in: q.status.split(',') as any } } : {}, q);
  }

  @Post('payouts/:id/:action(approve|paid|reject)')
  @HttpCode(200)
  @RequirePermissions('payouts.process')
  payout(
    @CurrentAdmin() a: AdminPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'approve' | 'paid' | 'reject',
    @Body() dto: PayoutActionDto,
    @Ip() ip: string,
  ) {
    return this.wallet.processPayout(a.id, id, action, dto, ip);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/disputes')
export class AdminDisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermissions('disputes.resolve')
  list(@Query() q: ListQuery) {
    return this.disputes.list(q);
  }

  @Get(':id')
  @RequirePermissions('disputes.resolve')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.disputes.get(id);
  }

  @Post(':id/investigate')
  @HttpCode(200)
  @RequirePermissions('disputes.resolve')
  investigate(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    return this.disputes.investigate(a.id, id, ip);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermissions('disputes.resolve')
  resolve(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveDisputeDto, @Ip() ip: string) {
    return this.disputes.resolve(a.id, id, dto, ip);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/broadcasts')
export class AdminBroadcastsController {
  constructor(private readonly broadcasts: BroadcastsService) {}

  /** Push messages sent so far, newest first. */
  @Get()
  @RequirePermissions('notifications.edit')
  list(@Query() q: CursorQuery) {
    return this.broadcasts.list(q);
  }

  /** How many people a message would reach. */
  @Get('count')
  @RequirePermissions('notifications.edit')
  count(@Query() q: BroadcastCountQuery) {
    return this.broadcasts.count(q.audience, q.phone);
  }

  /** Send a push message to all drivers, all customers, everyone, or one person. */
  @Post()
  @RequirePermissions('notifications.edit')
  send(@CurrentAdmin() a: AdminPrincipal, @Body() dto: BroadcastDto, @Ip() ip: string) {
    return this.broadcasts.send(a.id, dto, ip);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/notification-templates')
export class AdminTemplatesController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @RequirePermissions('notifications.edit')
  list() {
    return this.notifications.listTemplates();
  }

  @Put(':key')
  @RequirePermissions('notifications.edit')
  async update(@CurrentAdmin() a: AdminPrincipal, @Param('key') key: string, @Body() dto: TemplateDto, @Ip() ip: string) {
    const current = key === BROADCAST_TEMPLATE ? null : await this.notifications.template(key);
    if (!current) throw Errors.notFound('Template');
    if (dto.smsBody) this.notifications.validateSmsBody(dto.smsBody);
    const next = {
      pushTitle: dto.pushTitle === undefined ? (current.pushTitle ?? null) : dto.pushTitle,
      pushBody: dto.pushBody === undefined ? (current.pushBody ?? null) : dto.pushBody,
      smsBody: dto.smsBody === undefined ? (current.smsBody ?? null) : dto.smsBody,
      critical: dto.critical ?? current.critical,
    };
    const row = await this.prisma.notificationTemplate.upsert({ where: { key }, create: { key, ...next, updatedBy: a.id }, update: { ...next, updatedBy: a.id } });
    await this.audit.log({ actorId: a.id, actorType: 'admin', action: 'template.update', entity: 'notification_template', entityId: key, before: current, after: row, ip });
    return row;
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
export class AdminAccessController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('permissions')
  @RequirePermissions('admins.manage')
  permissions() {
    return this.users.permissions();
  }

  @Get('roles')
  @RequirePermissions('admins.manage')
  roles() {
    return this.users.roles();
  }

  @Post('roles')
  @RequirePermissions('admins.manage')
  createRole(@CurrentAdmin() a: AdminPrincipal, @Body() dto: RoleDto, @Ip() ip: string) {
    return this.users.upsertRole(a.id, null, dto, ip);
  }

  @Put('roles/:id')
  @RequirePermissions('admins.manage')
  updateRole(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RoleDto, @Ip() ip: string) {
    return this.users.upsertRole(a.id, id, dto, ip);
  }

  @Delete('roles/:id')
  @HttpCode(204)
  @RequirePermissions('admins.manage')
  async deleteRole(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Ip() ip: string) {
    await this.users.deleteRole(a.id, id, ip);
  }

  @Get('admins')
  @RequirePermissions('admins.manage')
  admins() {
    return this.users.admins();
  }

  @Post('admins')
  @RequirePermissions('admins.manage')
  createAdmin(@CurrentAdmin() a: AdminPrincipal, @Body() dto: CreateAdminDto, @Ip() ip: string) {
    return this.users.createAdmin(a.id, dto, ip);
  }

  @Patch('admins/:id')
  @RequirePermissions('admins.manage')
  updateAdmin(@CurrentAdmin() a: AdminPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminDto, @Ip() ip: string) {
    return this.users.updateAdmin(a.id, id, dto, ip);
  }

  @Get('audit-logs')
  @RequirePermissions('audit.view')
  async audit(@Query() q: AuditQuery) {
    const limit = pageLimit(q);
    const where: Prisma.AuditLogWhereInput = {};
    if (q.entity) where.entity = q.entity;
    if (q.entityId) where.entityId = q.entityId;
    if (q.actorId) where.actorId = q.actorId;
    if (q.action) where.action = { startsWith: q.action };
    const rows = await this.prisma.auditLog.findMany({ where: { AND: [where, cursorWhere(q.cursor)] }, orderBy: pageOrder, take: limit + 1 });
    return toPage(rows, limit);
  }
}

@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('daily')
  @RequirePermissions('reports.view')
  daily(@Query() q: RangeQuery) {
    return this.reports.daily(range(q));
  }

  @Get('payments')
  @RequirePermissions('reports.view')
  payments(@Query() q: RangeQuery) {
    return this.reports.paymentsByMethod(range(q));
  }

  @Get('drivers')
  @RequirePermissions('reports.view')
  drivers(@Query() q: RangeQuery) {
    return this.reports.driverPerformance(range(q));
  }

  @Get('daily.csv')
  @RequirePermissions('reports.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="cooper-waters-daily.csv"')
  dailyCsv(@Query() q: RangeQuery) {
    return this.reports.dailyCsv(range(q));
  }

  @Get('orders.csv')
  @RequirePermissions('reports.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="cooper-waters-orders.csv"')
  ordersCsv(@Query() q: RangeQuery) {
    return this.reports.ordersCsv(range(q));
  }

  @Get('payments.csv')
  @RequirePermissions('reports.view')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="cooper-waters-payments.csv"')
  paymentsCsv(@Query() q: RangeQuery) {
    return this.reports.paymentsCsv(range(q));
  }
}
