import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { loadEnv } from '../config/env';
import { AppError, Errors } from '../common/errors';
import { logger } from '../common/logger';
import { NotificationsService } from './notifications.service';
import { WHATSAPP_PROVIDER, WhatsAppProvider } from './whatsapp.provider';

/**
 * Meta WhatsApp webhook (configure in Meta App Dashboard → WhatsApp → Configuration):
 *   Callback URL: https://<api-host>/api/v1/webhooks/whatsapp     Verify token: WHATSAPP_VERIFY_TOKEN
 *   Subscribe to the `messages` field (delivery statuses arrive there).
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  constructor(
    private readonly notifications: NotificationsService,
    @Inject(WHATSAPP_PROVIDER) private readonly whatsapp: WhatsAppProvider | null,
  ) {}

  /** Meta's one-time subscription handshake: echo hub.challenge when the verify token matches. */
  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string, @Res() res: Response) {
    const expected = loadEnv().whatsapp.verifyToken;
    if (mode === 'subscribe' && expected && token === expected && challenge) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).json({ error: { code: 'forbidden', message: 'Verification failed' } });
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    if (!this.whatsapp) throw Errors.notFound('WhatsApp integration');
    if (!req.rawBody) throw Errors.badRequest('empty_body', 'Empty webhook body');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
    if (!this.whatsapp.verifyWebhook(headers, req.rawBody)) {
      throw new AppError('invalid_signature', 'Webhook signature verification failed', 401);
    }
    let statuses;
    try {
      statuses = this.whatsapp.parseStatuses(req.rawBody);
    } catch {
      throw Errors.badRequest('malformed_webhook', 'Webhook body could not be parsed');
    }
    // Light DB updates only; any SMS fallback is queued, so Meta gets a fast 200.
    await this.notifications.applyWhatsAppStatuses(statuses).catch((err) => logger.error({ err }, 'whatsapp status handling failed'));
    return { received: true };
  }
}
