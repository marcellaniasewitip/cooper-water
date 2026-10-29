import { INestApplication, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { raw } from 'express';
import * as Sentry from '@sentry/node';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/http-exception.filter';
import { loadEnv } from './config/env';
import { logger } from './common/logger';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

/** Shared app construction for the HTTP server, tests and OpenAPI generation. */
export async function createApp(opts: { logger?: boolean } = {}): Promise<NestExpressApplication> {
  const env = loadEnv();
  if (env.sentryDsn) Sentry.init({ dsn: env.sentryDsn, environment: env.nodeEnv, release: process.env.APP_VERSION });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    logger: opts.logger === false ? false : ['error', 'warn'],
  });
  configureApp(app);
  if (process.env.JOBS_DRIVER !== 'memory') app.useWebSocketAdapter(new RedisIoAdapter(app));
  return app;
}

export function configureApp(app: INestApplication): void {
  const env = loadEnv();
  app.setGlobalPrefix('api/v1', { exclude: [{ path: 'health', method: RequestMethod.GET }] });
  app.use(helmet());
  app.enableCors({ origin: env.corsOrigins, credentials: true, allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'], exposedHeaders: ['Content-Disposition', 'Idempotent-Replay'] });
  (app as NestExpressApplication).set?.('trust proxy', 1);
  (app as NestExpressApplication).useBodyParser?.('json', { limit: '1mb' });
  // Raw file bytes for the direct-upload fallback (the JSON parser ignores these content types).
  app.use('/api/v1/driver/uploads/direct', raw({ type: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'], limit: '10mb' }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandledRejection'));
}
