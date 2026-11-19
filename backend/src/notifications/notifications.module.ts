import { Global, Module } from '@nestjs/common';
import { loadEnv } from '../config/env';
import { NotificationsService } from './notifications.service';
import { PUSH_PROVIDER, createPushProvider } from './push.provider';
import { SMS_PROVIDER, createSmsProvider } from './sms.provider';
import { EMAIL_PROVIDER, createEmailProvider } from './email.provider';

@Global()
@Module({
  providers: [
    NotificationsService,
    { provide: SMS_PROVIDER, useFactory: () => createSmsProvider(loadEnv().smsProvider, loadEnv().clicksend) },
    { provide: PUSH_PROVIDER, useFactory: () => createPushProvider(loadEnv().pushProvider, loadEnv().fcmServiceAccountB64) },
    { provide: EMAIL_PROVIDER, useFactory: createEmailProvider },
  ],
  exports: [NotificationsService, EMAIL_PROVIDER],
})
export class NotificationsModule {}
