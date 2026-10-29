import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'crypto';
import { loadEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload } from './auth.types';
import { Errors } from '../common/errors';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A rotated refresh token may be presented again within this window without killing the session.
 * On patchy mobile data the server can rotate a token but the response never reaches the phone, so the
 * app retries with the old one; treating that as theft would sign the customer out for no reason.
 */
export const REFRESH_REUSE_GRACE_MS = 2 * 60_000;

/** JWT access tokens + opaque rotating refresh tokens (stored hashed). */
@Injectable()
export class TokensService {
  private readonly env = loadEnv();
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async issue(payload: AccessTokenPayload): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.env.jwtAccessSecret,
      expiresIn: this.env.jwtAccessTtlSec,
    });
    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        subjectId: payload.sub,
        subjectType: payload.typ,
        userId: payload.typ === 'user' ? payload.sub : null,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Date.now() + this.env.jwtRefreshTtlSec * 1000),
      },
    });
    return { accessToken, refreshToken: `${payload.typ}.${refreshToken}`, expiresIn: this.env.jwtAccessTtlSec };
  }

  async verifyAccess(token: string): Promise<AccessTokenPayload> {
    try {
      return await this.jwt.verifyAsync<AccessTokenPayload>(token, { secret: this.env.jwtAccessSecret });
    } catch {
      throw Errors.unauthorized('Invalid or expired token');
    }
  }

  /** Rotate: the presented refresh token is revoked and a new pair issued. Reuse of a revoked token revokes all. */
  async refresh(presented: string, build: (subjectId: string, typ: 'user' | 'admin') => Promise<AccessTokenPayload>): Promise<TokenPair> {
    const [typ, raw] = presented.split('.', 2);
    if ((typ !== 'user' && typ !== 'admin') || !raw) throw Errors.unauthorized('Invalid refresh token');
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(raw) } });
    if (!row || row.subjectType !== typ) throw Errors.unauthorized('Invalid refresh token');
    if (row.revokedAt) {
      // Rotation leaves expiresAt in the future; logout, suspension and theft response also expire the
      // token, so only a just-rotated token qualifies for the retry grace.
      const rotated = row.expiresAt > row.revokedAt;
      if (rotated && Date.now() - row.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
        return this.issue(await build(row.subjectId, typ));
      }
      // Token reuse → likely theft. Kill every session for this subject.
      await this.killAll(row.subjectId);
      throw Errors.unauthorized('Refresh token already used');
    }
    if (row.expiresAt < new Date()) throw Errors.unauthorized('Refresh token expired');
    const claimed = await this.prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
    if (claimed.count !== 1) throw Errors.unauthorized('Refresh token already used');
    const payload = await build(row.subjectId, typ);
    return this.issue(payload);
  }

  async revoke(presented: string): Promise<void> {
    const raw = presented.split('.', 2)[1];
    if (!raw) return;
    const now = new Date();
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(raw), revokedAt: null }, data: { revokedAt: now, expiresAt: now } });
  }

  async revokeAll(subjectId: string): Promise<void> {
    await this.killAll(subjectId);
  }

  /** Revoke and expire every token of the subject, including rotated ones still inside the grace window. */
  private async killAll(subjectId: string): Promise<void> {
    const now = new Date();
    await this.prisma.refreshToken.updateMany({ where: { subjectId, expiresAt: { gt: now } }, data: { revokedAt: now, expiresAt: now } });
  }
}
