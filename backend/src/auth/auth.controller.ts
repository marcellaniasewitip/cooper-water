import { Body, Controller, Get, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminOnly, CurrentAdmin, Public } from './decorators';
import { AdminLoginDto, AdminTotpVerifyDto, RefreshDto, RequestOtpDto, TotpCodeDto, VerifyOtpDto } from './auth.dto';
import { UserAuthService } from './user-auth.service';
import { AdminAuthService } from './admin-auth.service';
import { TokensService } from './tokens.service';
import { AdminPrincipal } from './auth.types';

// Strict per-IP limits only on credential-guessing endpoints. They stay generous because PNG mobile
// networks put many users behind carrier-grade NAT; per-phone OTP limits (OtpService) are the real brake.
// Session endpoints (refresh, me, TOTP setup) use the global per-account budget.
const CREDENTIAL_LIMIT = { default: { limit: 30, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly users: UserAuthService,
    private readonly admins: AdminAuthService,
    private readonly tokens: TokensService,
  ) {}

  /** Send a one-time code by SMS. */
  @Public()
  @Post('otp/request')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  requestOtp(@Body() dto: RequestOtpDto, @Ip() ip: string) {
    return this.users.requestOtp(dto.phone, ip ?? null);
  }

  /** Verify the code; registers the account on first sign-in. */
  @Public()
  @Post('otp/verify')
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.users.verifyOtp(dto.phone, dto.code, dto.app, dto.name);
  }

  /** Exchange a refresh token for a new pair (rotation). Works for users and admins. */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.users.refresh(dto.refreshToken);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() dto: RefreshDto) {
    await this.tokens.revoke(dto.refreshToken);
  }

  @Public()
  @Post('admin/login')
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  adminLogin(@Body() dto: AdminLoginDto, @Ip() ip: string) {
    return this.admins.login(dto.email, dto.password, ip ?? null);
  }

  @Public()
  @Post('admin/totp/verify')
  @Throttle(CREDENTIAL_LIMIT)
  @HttpCode(200)
  adminTotpVerify(@Body() dto: AdminTotpVerifyDto, @Ip() ip: string) {
    return this.admins.verifyTotp(dto.mfaToken, dto.code, ip ?? null);
  }

  @ApiBearerAuth()
  @AdminOnly()
  @Get('admin/me')
  adminMe(@CurrentAdmin() admin: AdminPrincipal) {
    return this.admins.me(admin.id);
  }

  @ApiBearerAuth()
  @AdminOnly()
  @Post('admin/totp/setup')
  @HttpCode(200)
  totpSetup(@CurrentAdmin() admin: AdminPrincipal) {
    return this.admins.setupTotp(admin.id);
  }

  @ApiBearerAuth()
  @AdminOnly()
  @Post('admin/totp/enable')
  @HttpCode(204)
  async totpEnable(@CurrentAdmin() admin: AdminPrincipal, @Body() dto: TotpCodeDto, @Ip() ip: string) {
    await this.admins.enableTotp(admin.id, dto.code, ip ?? null);
  }
}
