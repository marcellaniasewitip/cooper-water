import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OtpService } from './otp.service';
import { TokensService, TokenPair } from './tokens.service';
import { normalisePhone } from '../common/phone';
import { Errors } from '../common/errors';
import { AccessTokenPayload } from './auth.types';

@Injectable()
export class UserAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokensService,
  ) {}

  async requestOtp(phoneInput: string, ip: string | null, channel?: 'whatsapp' | 'sms') {
    const phone = normalisePhone(phoneInput);
    const sent = await this.otp.request(phone, ip, channel);
    return { phone, ...sent };
  }

  async resendOtpBySms(phoneInput: string) {
    const phone = normalisePhone(phoneInput);
    const sent = await this.otp.resendBySms(phone);
    return { phone, ...sent };
  }

  /**
   * Verify the OTP and sign in, registering the account on first login.
   * MVP: one phone number = one role. A driver's number can't sign in to the customer app and vice versa.
   */
  async verifyOtp(phoneInput: string, code: string, app: UserRole, name?: string): Promise<TokenPair & { user: any; isNew: boolean }> {
    const phone = normalisePhone(phoneInput);
    await this.otp.verify(phone, code);
    let user = await this.prisma.user.findUnique({ where: { phone } });
    let isNew = false;
    if (!user) {
      isNew = true;
      user = await this.prisma.user.create({
        data: {
          phone,
          role: app,
          name: name?.trim() || null,
          phoneVerifiedAt: new Date(),
          ...(app === 'driver' ? { driver: { create: {} } } : {}),
        },
      });
      if (app === 'driver') {
        const driver = await this.prisma.driver.findUniqueOrThrow({ where: { userId: user.id } });
        await this.prisma.wallet.create({ data: { ownerType: 'driver', ownerId: driver.id } });
      }
    } else {
      if (user.role !== app) {
        throw Errors.forbidden(
          user.role === 'driver'
            ? 'This number is registered as a driver. Use the Cooper Waters Driver app.'
            : 'This number is registered as a customer. Use the Cooper Waters app.',
        );
      }
      if (user.status !== 'active' || user.deletedAt) throw Errors.forbidden('Your account is suspended. Contact Cooper Waters support.');
      if (!user.phoneVerifiedAt) user = await this.prisma.user.update({ where: { id: user.id }, data: { phoneVerifiedAt: new Date() } });
    }
    const pair = await this.tokens.issue({ sub: user.id, typ: 'user', role: user.role });
    return { ...pair, user: { id: user.id, phone: user.phone, name: user.name, role: user.role }, isNew };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    return this.tokens.refresh(refreshToken, async (subjectId, typ): Promise<AccessTokenPayload> => {
      if (typ === 'admin') {
        const admin = await this.prisma.adminUser.findUnique({ where: { id: subjectId } });
        if (!admin || admin.status !== 'active') throw Errors.unauthorized();
        return { sub: admin.id, typ: 'admin', mfa: true };
      }
      const user = await this.prisma.user.findUnique({ where: { id: subjectId } });
      if (!user || user.status !== 'active' || user.deletedAt) throw Errors.unauthorized();
      return { sub: user.id, typ: 'user', role: user.role };
    });
  }
}
