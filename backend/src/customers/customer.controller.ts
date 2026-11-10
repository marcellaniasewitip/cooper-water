import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/decorators';
import { UserPrincipal } from '../auth/auth.types';
import { Idempotent, IdempotencyKey } from '../common/idempotency';
import { CursorQuery } from '../common/pagination';
import { CustomersService } from './customers.service';
import { CatalogueService } from '../catalogue/catalogue.service';
import { OrdersService } from '../orders/orders.service';
import { PaymentsService } from '../payments/payments.service';
import { RatingsService } from '../disputes/ratings.service';
import { DisputesService } from '../disputes/disputes.service';
import { SettingsService } from '../settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChatSendDto, CustomerTopupDto, LocationDto, PromoCheckDto, PushTokenDto, ReferralApplyDto, UpdateLocationDto, UpdateProfileDto } from './customer.dto';
import { WalletService } from '../wallet/wallet.service';
import { PromosService } from '../promos/promos.service';
import { ReferralsService } from '../referrals/referrals.service';
import { ChatService } from '../chat/chat.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CancelDto, CreateOrderDto, DisputeDto, QuoteDto, RateDto, StartPaymentDto } from '../orders/orders.dto';
import { AppError } from '../common/errors';

@ApiTags('customer')
@ApiBearerAuth()
@Roles('customer')
@Controller('customer')
export class CustomerController {
  constructor(
    private readonly customers: CustomersService,
    private readonly catalogue: CatalogueService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly ratings: RatingsService,
    private readonly disputes: DisputesService,
    private readonly wallet: WalletService,
    private readonly promos: PromosService,
    private readonly referrals: ReferralsService,
    private readonly chat: ChatService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  me(@CurrentUser() u: UserPrincipal) {
    return this.customers.me(u.id);
  }

  @Patch('me')
  updateMe(@CurrentUser() u: UserPrincipal, @Body() dto: UpdateProfileDto) {
    return this.customers.updateProfile(u.id, dto.name);
  }

  @Put('me/push-token')
  @HttpCode(204)
  async pushToken(@CurrentUser() u: UserPrincipal, @Body() dto: PushTokenDto) {
    await this.customers.setPushToken(u.id, dto.token || null);
  }

  /** App configuration the customer app needs (cancel rules, limits, dispute categories). */
  @Get('config')
  async config() {
    return {
      currency: 'PGK',
      timeZone: 'Pacific/Port_Moresby',
      cancelFreeUntil: await this.settings.get('order.customer_cancel_free_until'),
      maxQuantity: await this.settings.get('order.max_quantity'),
      disputeCategories: await this.settings.get('dispute.categories'),
      paymentMethods: ['cod', 'cellmoney'],
      cellmoneyTimeoutSec: await this.settings.get('payment.cellmoney.timeout_sec'),
      autoCompleteAfterSec: await this.settings.get('order.auto_complete_after_sec'),
    };
  }

  @Get('locations')
  locations(@CurrentUser() u: UserPrincipal) {
    return this.customers.locations(u.id);
  }

  @Post('locations')
  addLocation(@CurrentUser() u: UserPrincipal, @Body() dto: LocationDto) {
    return this.customers.addLocation(u.id, dto);
  }

  @Patch('locations/:id')
  updateLocation(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.customers.updateLocation(u.id, id, dto);
  }

  @Delete('locations/:id')
  @HttpCode(204)
  async deleteLocation(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.customers.deleteLocation(u.id, id);
  }

  @Get('packages')
  async packages() {
    const rows = await this.catalogue.activePackages();
    return rows.map((p) => ({ id: p.id, name: p.name, volumeLitres: p.volumeLitres, priceToea: p.priceToea }));
  }

  /** Fixed price quote. */
  @Post('quote')
  @HttpCode(200)
  quote(@CurrentUser() u: UserPrincipal, @Body() dto: QuoteDto) {
    return this.orders.quote(dto.packageId, dto.quantity, { customerId: u.id, code: dto.promoCode });
  }

  /**
   * Place an order. Cash on delivery goes straight to finding a driver. Cell money starts the collection
   * on `msisdn` (default: account phone) and returns the payment with instructions.
   */
  @Post('orders')
  @Idempotent()
  async createOrder(@CurrentUser() u: UserPrincipal, @Body() dto: CreateOrderDto, @IdempotencyKey() key: string) {
    const order = await this.orders.create(u.id, dto);
    let payment = null;
    let paymentError = null;
    if (dto.paymentMethod === 'cellmoney') {
      try {
        payment = await this.payments.startOrderPayment(u.id, order.id, dto.msisdn ?? u.phone, key);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        paymentError = (err.getResponse() as any).error;
      }
    }
    return { order: await this.orders.getForCustomer(u.id, order.id), payment, paymentError };
  }

  @Get('orders')
  listOrders(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    return this.orders.listForCustomer(u.id, q);
  }

  @Get('orders/:id')
  getOrder(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getForCustomer(u.id, id);
  }

  /** Retry starting the cell money collection while the order is still PENDING_PAYMENT. */
  @Post('orders/:id/payment')
  @Idempotent()
  startPayment(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StartPaymentDto, @IdempotencyKey() key: string) {
    return this.payments.startOrderPayment(u.id, id, dto.msisdn, key);
  }

  @Get('orders/:id/payment')
  async getPayment(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.orders.getForCustomer(u.id, id);
    const p = await this.prisma.payment.findFirst({ where: { purpose: 'order', purposeId: id, direction: 'in' }, orderBy: { createdAt: 'desc' } });
    return p ? this.payments.view(p) : null;
  }

  @Post('orders/:id/cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDto) {
    await this.orders.cancelByCustomer(u.id, id, dto.reason);
    return this.orders.getForCustomer(u.id, id);
  }

  /** Confirm receipt (DELIVERED → COMPLETED). */
  @Post('orders/:id/confirm')
  @HttpCode(200)
  async confirm(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.orders.confirmReceipt(u.id, id);
    return this.orders.getForCustomer(u.id, id);
  }

  @Post('orders/:id/rating')
  rate(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RateDto) {
    return this.ratings.rate(u.id, id, dto.stars, dto.comment);
  }

  @Post('orders/:id/disputes')
  dispute(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisputeDto) {
    return this.disputes.raise({ type: 'customer', userId: u.id }, id, dto.category, dto.description);
  }

  // ───────────── Wallet (StarTrip "cash") ─────────────

  @Get('wallet')
  walletSummary(@CurrentUser() u: UserPrincipal) {
    return this.wallet.customerSummary(u.id);
  }

  @Get('wallet/entries')
  async walletEntries(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    const s = await this.wallet.customerSummary(u.id);
    return this.wallet.entries(s.walletId, q);
  }

  /** Top up by cash, bank transfer or cell money; an admin approves it in Wallet top-ups. */
  @Post('wallet/topups')
  @Idempotent()
  walletTopup(@CurrentUser() u: UserPrincipal, @Body() dto: CustomerTopupDto, @IdempotencyKey() key: string) {
    return this.wallet.submitCustomerTopup(u.id, dto, key);
  }

  @Get('wallet/topups')
  walletTopups(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    return this.wallet.customerTopups(u.id, q);
  }

  // ───────────── Offers ─────────────

  @Get('offers')
  offers(@CurrentUser() u: UserPrincipal) {
    return this.promos.offersFor(u.id);
  }

  @Post('offers/check')
  @HttpCode(200)
  checkOffer(@CurrentUser() u: UserPrincipal, @Body() dto: PromoCheckDto) {
    return this.promos.describe(dto.code, u.id);
  }

  // ───────────── Refer & Earn ─────────────

  @Get('referral')
  referral(@CurrentUser() u: UserPrincipal) {
    return this.referrals.summary(u.id);
  }

  @Post('referral/apply')
  @HttpCode(200)
  applyReferral(@CurrentUser() u: UserPrincipal, @Body() dto: ReferralApplyDto) {
    return this.referrals.apply(u.id, dto.code);
  }

  // ───────────── Inbox & chat ─────────────

  @Get('inbox')
  inbox(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    return this.notifications.inbox(u.id, q);
  }

  @Get('chats')
  chats(@CurrentUser() u: UserPrincipal) {
    return this.chat.conversations(u.id, 'customer');
  }

  @Get('orders/:id/messages')
  messages(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.messages(id, u.id, 'customer');
  }

  @Post('orders/:id/messages')
  sendMessage(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ChatSendDto) {
    return this.chat.send(id, u.id, 'customer', dto.body);
  }
}
