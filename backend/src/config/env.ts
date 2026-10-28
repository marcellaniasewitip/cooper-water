/**
 * Environment configuration. Secrets come from environment variables only (§12).
 * Validated once at boot; the process refuses to start with missing required values in production.
 */
function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v === 'true' || v === '1';
}

export interface Env {
  nodeEnv: string;
  isProd: boolean;
  isTest: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  /** Namespaces BullMQ queues and Socket.IO channels so environments can share one Redis. */
  redisPrefix: string;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  jwtAccessTtlSec: number;
  jwtRefreshTtlSec: number;
  corsOrigins: string[];
  s3Bucket: string;
  s3Region: string;
  s3Endpoint?: string;
  s3ForcePathStyle: boolean;
  smsProvider: string;
  /** none | mock | meta — WhatsApp delivery of sign-in codes (SMS stays the fallback). */
  whatsappProvider: string;
  whatsapp: {
    accessToken: string;
    phoneNumberId: string;
    appSecret: string;
    verifyToken: string;
    templateName: string;
    templateLanguage: string;
    apiVersion: string;
  };
  pushProvider: string;
  fcmServiceAccountB64?: string;
  mockCellmoneyWebhookSecret: string;
  sentryDsn?: string;
  logLevel: string;
  runWorkers: boolean;
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;
  const nodeEnv = str('NODE_ENV', 'development');
  const isProd = nodeEnv === 'production';
  const devDefault = (v: string) => (isProd ? undefined : v);
  cached = {
    nodeEnv,
    isProd,
    isTest: nodeEnv === 'test',
    port: int('PORT', 3000),
    databaseUrl: str('DATABASE_URL'),
    redisUrl: str('REDIS_URL', devDefault('redis://localhost:6379')),
    redisPrefix: str('REDIS_PREFIX', 'cw'),
    jwtAccessSecret: str('JWT_ACCESS_SECRET', devDefault('dev-access-secret-change-me')),
    jwtRefreshSecret: str('JWT_REFRESH_SECRET', devDefault('dev-refresh-secret-change-me')),
    jwtAccessTtlSec: int('JWT_ACCESS_TTL_SEC', 900),
    jwtRefreshTtlSec: int('JWT_REFRESH_TTL_SEC', 30 * 24 * 3600),
    corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    s3Bucket: str('S3_BUCKET', devDefault('cooper-waters-dev')),
    s3Region: str('S3_REGION', 'ap-southeast-2'),
    s3Endpoint: process.env.S3_ENDPOINT?.trim() || undefined,
    s3ForcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
    smsProvider: str('SMS_PROVIDER', 'mock'),
    whatsappProvider: str('WHATSAPP_PROVIDER', 'none'),
    whatsapp: {
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN?.trim() ?? '',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() ?? '',
      appSecret: process.env.WHATSAPP_APP_SECRET?.trim() || (isProd ? '' : 'dev-whatsapp-app-secret'),
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN?.trim() || (isProd ? '' : 'dev-whatsapp-verify-token'),
      templateName: str('WHATSAPP_OTP_TEMPLATE', 'cooper_waters_otp'),
      templateLanguage: str('WHATSAPP_OTP_LANGUAGE', 'en'),
      apiVersion: str('WHATSAPP_API_VERSION', 'v21.0'),
    },
    pushProvider: str('PUSH_PROVIDER', 'mock'),
    fcmServiceAccountB64: process.env.FCM_SERVICE_ACCOUNT_B64?.trim() || undefined,
    mockCellmoneyWebhookSecret: str('MOCK_CELLMONEY_WEBHOOK_SECRET', devDefault('dev-webhook-secret')),
    sentryDsn: process.env.SENTRY_DSN?.trim() || undefined,
    logLevel: str('LOG_LEVEL', 'info'),
    runWorkers: bool('RUN_WORKERS', true),
  };
  if (isProd && cached.mockCellmoneyWebhookSecret === 'dev-webhook-secret') {
    throw new Error('Refusing to start in production with the dev webhook secret');
  }
  if (isProd && cached.whatsappProvider === 'mock') {
    throw new Error('Refusing to start in production with WHATSAPP_PROVIDER=mock');
  }
  if (isProd && cached.smsProvider === 'mock') {
    // eslint-disable-next-line no-console
    console.warn('WARNING: SMS_PROVIDER=mock in production — OTP codes are only written to logs. Configure the SMS gateway before go-live.');
  }
  return cached;
}

/** Test helper: forget the cached env so tests can change process.env. */
export function resetEnvCache(): void {
  cached = undefined;
}
