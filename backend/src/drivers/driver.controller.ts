import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/decorators';
import { UserPrincipal } from '../auth/auth.types';
import { Idempotent, IdempotencyKey } from '../common/idempotency';
import { CursorQuery } from '../common/pagination';
import { startOfBusinessDay } from '../common/time';
import { DriversService } from './drivers.service';
import { OrdersService } from '../orders/orders.service';
import { WalletService } from '../wallet/wallet.service';
import { PaymentsService } from '../payments/payments.service';
import { CatalogueService } from '../catalogue/catalogue.service';
import { DisputesService } from '../disputes/disputes.service';
import { CustomersService } from '../customers/customers.service';
import { SettingsService } from '../settings/settings.service';
import { PushTokenDto, UpdateProfileDto } from '../customers/customer.dto';
import { DeliveredDto, DisputeDto, PositionDto } from '../orders/orders.dto';
import { EarningsQuery, LocationBatchDto, OptionalPositionDto, SubmitDocumentDto, TopupDto, TruckDto, UploadRequestDto, WithdrawalDto } from './driver.dto';
import { Errors } from '../common/errors';

@ApiTags('driver')
@ApiBearerAuth()
@Roles('driver')
@Controller('driver')
export class DriverController {
  constructor(
    private readonly drivers: DriversService,
    private readonly orders: OrdersService,
    private readonly wallet: WalletService,
    private readonly payments: PaymentsService,
    private readonly catalogue: CatalogueService,
    private readonly disputes: DisputesService,
    private readonly customers: CustomersService,
    private readonly settings: SettingsService,
  ) {}

  private async driverId(u: UserPrincipal): Promise<string> {
    return (await this.drivers.byUserId(u.id)).id;
  }

  // ───────────── Profile & onboarding ─────────────

  @Get('me')
  async me(@CurrentUser() u: UserPrincipal) {
    return this.drivers.profile(await this.driverId(u));
  }

  @Patch('me')
  async updateMe(@CurrentUser() u: UserPrincipal, @Body() dto: UpdateProfileDto) {
    await this.customers.updateProfile(u.id, dto.name);
    return this.drivers.profile(await this.driverId(u));
  }

  @Put('me/push-token')
  @HttpCode(204)
  async pushToken(@CurrentUser() u: UserPrincipal, @Body() dto: PushTokenDto) {
    await this.customers.setPushToken(u.id, dto.token || null);
  }

  @Get('config')
  async config() {
    return {
      requiredDocuments: await this.settings.get('driver.required_documents'),
      minBalanceToea: await this.settings.get('wallet.min_balance_toea'),
      onlineRequiresDepot: await this.settings.get('depot.online_gated'),
      locationIntervalSec: 20,
      disputeCategories: await this.settings.get('dispute.categories'),
      merchantNumber: await this.settings.get('payment.cellmoney.merchant_number'),
    };
  }

  /** Get a presigned PUT URL; upload the file there, then submit the returned key. */
  @Post('uploads')
  @HttpCode(200)
  async upload(@CurrentUser() u: UserPrincipal, @Body() dto: UploadRequestDto) {
    return this.drivers.presignUpload(await this.driverId(u), dto.purpose, dto.contentType, dto.contentLength);
  }

  /**
   * Fallback upload through the API: raw file bytes as the body (Content-Type image/jpeg, png, webp or pdf),
   * `?purpose=` as for /uploads. Returns `{ key }` to submit exactly like a presigned upload's key.
   */
  @Post('uploads/direct')
  @HttpCode(200)
  @ApiHeader({ name: 'x-upload-fallback-reason', required: false, description: 'Why the presigned PUT failed (logged)' })
  async uploadDirect(
    @CurrentUser() u: UserPrincipal,
    @Query('purpose') purpose: string,
    @Req() req: Request,
    @Headers('x-upload-fallback-reason') reason?: string,
  ) {
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    return this.drivers.uploadDirect(await this.driverId(u), purpose, contentType, body, reason);
  }

  @Post('documents')
  async submitDocument(@CurrentUser() u: UserPrincipal, @Body() dto: SubmitDocumentDto) {
    return this.drivers.submitDocument(await this.driverId(u), dto.type, dto.fileKey);
  }

  @Put('truck')
  async truck(@CurrentUser() u: UserPrincipal, @Body() dto: TruckDto) {
    return this.drivers.upsertTruck(await this.driverId(u), dto);
  }

  @Get('depots')
  async depots() {
    const rows = await this.catalogue.activeDepots();
    const radius = await this.settings.get('depot.geofence_radius_m');
    return rows.map((d) => ({ id: d.id, name: d.name, lat: d.lat, lng: d.lng, geofenceRadiusM: d.geofenceRadiusM ?? radius, geofencePolygon: d.geofencePolygon }));
  }

  // ───────────── Availability ─────────────

  /** Go online (depot-gated and wallet-gated). */
  @Post('online')
  @HttpCode(200)
  async online(@CurrentUser() u: UserPrincipal, @Body() dto: PositionDto) {
    return this.drivers.goOnline(await this.driverId(u), dto.lat, dto.lng);
  }

  @Post('offline')
  @HttpCode(200)
  async offline(@CurrentUser() u: UserPrincipal) {
    return this.drivers.goOffline(await this.driverId(u));
  }

  /** Batched location updates every 15–30 s while online. */
  @Post('location')
  @HttpCode(200)
  async location(@CurrentUser() u: UserPrincipal, @Body() dto: LocationBatchDto) {
    return this.drivers.updateLocation(await this.driverId(u), dto.points);
  }

  // ───────────── Jobs ─────────────

  @Get('offers')
  async offers(@CurrentUser() u: UserPrincipal) {
    return this.orders.openOffers(await this.driverId(u));
  }

  /** First-come-first-served. 409 `order_taken` if someone else won. */
  @Post('orders/:id/accept')
  @HttpCode(200)
  @Idempotent()
  async accept(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.accept(await this.driverId(u), id);
  }

  @Post('orders/:id/decline')
  @HttpCode(204)
  async decline(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    await this.orders.decline(await this.driverId(u), id);
  }

  @Get('orders/active')
  async active(@CurrentUser() u: UserPrincipal) {
    return this.orders.activeForDriver(await this.driverId(u));
  }

  @Get('orders')
  async history(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    return this.orders.historyForDriver(await this.driverId(u), q);
  }

  @Get('orders/:id')
  async getOrder(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.getForDriver(await this.driverId(u), id);
  }

  /** At the depot: ACCEPTED → LOADING (geofence). */
  @Post('orders/:id/arrive-depot')
  @HttpCode(200)
  async arriveDepot(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PositionDto) {
    return this.orders.arriveAtDepot(await this.driverId(u), id, dto.lat, dto.lng);
  }

  /** Loaded: LOADING → EN_ROUTE (geofence). */
  @Post('orders/:id/loaded')
  @HttpCode(200)
  async loaded(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PositionDto) {
    return this.orders.confirmLoaded(await this.driverId(u), id, dto.lat, dto.lng);
  }

  @Post('orders/:id/arrived')
  @HttpCode(200)
  async arrived(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OptionalPositionDto) {
    return this.orders.markArrived(await this.driverId(u), id, dto.lat, dto.lng);
  }

  @Post('orders/:id/delivered')
  @HttpCode(200)
  async delivered(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DeliveredDto) {
    return this.orders.markDelivered(await this.driverId(u), id, dto.proofPhotoKey);
  }

  /** Report an issue with a job (raises a dispute). */
  @Post('orders/:id/issues')
  async issue(@CurrentUser() u: UserPrincipal, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DisputeDto) {
    return this.disputes.raise({ type: 'driver', userId: u.id, driverId: await this.driverId(u) }, id, dto.category, dto.description);
  }

  // ───────────── Wallet ─────────────

  @Get('wallet')
  async walletSummary(@CurrentUser() u: UserPrincipal) {
    return this.wallet.summary(await this.driverId(u));
  }

  @Get('wallet/entries')
  async entries(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    const s = await this.wallet.summary(await this.driverId(u));
    return this.wallet.entries(s.walletId, q);
  }

  @Post('wallet/topups')
  @Idempotent()
  async topup(@CurrentUser() u: UserPrincipal, @Body() dto: TopupDto, @IdempotencyKey() key: string) {
    const driverId = await this.driverId(u);
    if (dto.method === 'bank_transfer') {
      if (!dto.referenceText) throw Errors.invalid('reference_required', 'Enter the bank transfer reference');
      return { topup: await this.wallet.submitBankTopup(driverId, { amountToea: dto.amountToea, referenceText: dto.referenceText, proofFileKey: dto.proofFileKey }, key), payment: null };
    }
    return this.payments.startTopup(driverId, dto.amountToea, dto.msisdn ?? u.phone, key);
  }

  @Get('wallet/topups')
  async topups(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    return this.wallet.listTopups({ driverId: await this.driverId(u) }, q);
  }

  @Post('wallet/withdrawals')
  @Idempotent()
  async withdraw(@CurrentUser() u: UserPrincipal, @Body() dto: WithdrawalDto, @IdempotencyKey() key: string) {
    return this.wallet.requestPayout(await this.driverId(u), dto, key);
  }

  @Get('wallet/withdrawals')
  async withdrawals(@CurrentUser() u: UserPrincipal, @Query() q: CursorQuery) {
    return this.wallet.listPayouts({ driverId: await this.driverId(u) }, q);
  }

  @Get('earnings')
  async earnings(@CurrentUser() u: UserPrincipal, @Query() q: EarningsQuery) {
    const today = startOfBusinessDay();
    const days = q.period === 'month' ? 30 : q.period === 'week' ? 7 : 1;
    if (days < 1) throw new BadRequestException();
    const since = new Date(today.getTime() - (days - 1) * 24 * 3600_000);
    return this.wallet.earningsSummary(await this.driverId(u), since);
  }
}
