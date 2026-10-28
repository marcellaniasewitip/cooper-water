import { Injectable } from '@nestjs/common';
import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { NotificationsService, OtpChannel } from '../notifications/notifications.service';
import { Errors } from '../common/errors';

const hash = (phone: string, code: string) => createHash('sha256').update(`${phone}:${code}`).digest('hex');

@Injectable()
export class OtpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Issue and send a 6-digit OTP (WhatsApp first when configured, else SMS; `prefer: 'sms'` forces SMS).
   * Rate-limited per phone and per IP (§9, §11).
   */
  async request(phone: string, ip: string | null, prefer?: OtpChannel): Promise<{ ttlSec: number; channel: OtpChannel }> {
    const [ttlSec, perPhone, perIp] = await Promise.all([
      this.settings.get('otp.ttl_sec'),
      this.settings.get('otp.max_sends_per_phone_per_hour'),
      this.settings.get('otp.max_sends_per_ip_per_hour'),
    ]);
    const since = new Date(Date.now() - 3600_000);
    const [phoneCount, ipCount] = await Promise.all([
      this.prisma.otpCode.count({ where: { phone, createdAt: { gte: since } } }),
      ip ? this.prisma.otpCode.count({ where: { ip, createdAt: { gte: since } } }) : Promise.resolve(0),
    ]);
    if (phoneCount >= perPhone || ipCount >= perIp) throw Errors.tooMany('Too many codes requested. Try again later.');

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    // Only the newest code is valid.
    await this.prisma.otpCode.updateMany({ where: { phone, usedAt: null }, data: { usedAt: new Date() } });
    const otp = await this.prisma.otpCode.create({
      data: { phone, codeHash: hash(phone, code), expiresAt: new Date(Date.now() + ttlSec * 1000), ip },
    });
    const channel = await this.notifications.sendOtp(phone, code, ttlSec, { otpId: otp.id, prefer });
    return { ttlSec, channel };
  }

  /** "Send by SMS instead": the current code (not a new one), so a late WhatsApp message still works. */
  async resendBySms(phone: string): Promise<{ ttlSec: number; channel: OtpChannel }> {
    const otp = await this.prisma.otpCode.findFirst({ where: { phone, usedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!otp || otp.expiresAt <= new Date()) throw Errors.invalid('otp_expired', 'The code has expired. Request a new one.');
    const channel = await this.notifications.resendOtpBySms(phone, otp.id);
    return { ttlSec: Math.max(0, Math.floor((otp.expiresAt.getTime() - Date.now()) / 1000)), channel };
  }

  /** Throws on a wrong, expired, used or over-attempted code. */
  async verify(phone: string, code: string): Promise<void> {
    const maxAttempts = await this.settings.get('otp.max_attempts');
    const otp = await this.prisma.otpCode.findFirst({ where: { phone, usedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!otp || otp.expiresAt < new Date()) throw Errors.invalid('otp_expired', 'The code has expired. Request a new one.');
    if (otp.attempts >= maxAttempts) throw Errors.tooMany('Too many wrong attempts. Request a new code.');
    const ok = timingSafeEqual(Buffer.from(otp.codeHash), Buffer.from(hash(phone, code)));
    if (!ok) {
      await this.prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      throw Errors.invalid('otp_invalid', 'That code is not correct');
    }
    // Single use, race-safe.
    const used = await this.prisma.otpCode.updateMany({ where: { id: otp.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw Errors.invalid('otp_expired', 'The code has already been used');
  }
}
