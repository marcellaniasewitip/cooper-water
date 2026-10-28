import { Global, Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { NotificationsService } from './notifications.service';
import { PUSH_PROVIDER, createPushProvider } from './push.provider';
import { SMS_PROVIDER, createSmsProvider } from './sms.provider';
import { WHATSAPP_PROVIDER, createWhatsAppProvider } from './whatsapp.provider';

@Global()
@Module({
  providers: [
    NotificationsService,
    { provide: SMS_PROVIDER, useFactory: () => createSmsProvider(loadEnv().smsProvider) },
    {
      provide: WHATSAPP_PROVIDER,
      useFactory: () => {
        const env = loadEnv();
        return createWhatsAppProvider(env.whatsappProvider, { meta: env.whatsapp, mockSecret: env.whatsapp.appSecret });
      },
    },
    { provide: PUSH_PROVIDER, useFactory: () => createPushProvider(loadEnv().pushProvider, loadEnv().fcmServiceAccountB64) },
  ],
  exports: [NotificationsService, WHATSAPP_PROVIDER],
})
export class NotificationsModule {}
