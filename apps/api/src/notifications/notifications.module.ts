import { Global, Logger, Module } from "@nestjs/common";
import { loadEnv } from "../config/env";
import { ConsoleDriver } from "src/otp/channels/console.driver";
import { NOTIFICATION_CHANNELS, NotificationChannel } from "src/otp/channels/notification.channel";
import { WhatsAppDriver } from "src/otp/channels/whatsapp.driver";
import { EmailDriver } from "src/otp/channels/email.driver";
import { NotificationDispatcher } from "src/otp/channels/dispatcher";

/**
 * Picks a driver per channel based on which credentials exist. Absent
 * credentials fall back to the console driver rather than disabling the
 * channel, so the flow above stays identical in every environment.
 */
@Global()
@Module({
  providers: [
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (): NotificationChannel[] => {
        const env = loadEnv();
        const logger = new Logger("NotificationsModule");
        const channels: NotificationChannel[] = [];

        if (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_ACCESS_TOKEN) {
          channels.push(new WhatsAppDriver(env));
        } else {
          logger.warn("WhatsApp credentials absent — using console driver");
          channels.push(new ConsoleDriver("whatsapp"));
        }

        if (env.RESEND_API_KEY) {
          channels.push(new EmailDriver(env));
        } else {
          logger.warn("Resend credentials absent — using console driver");
          channels.push(new ConsoleDriver("email"));
        }

        return channels;
      },
    },
    NotificationDispatcher,
  ],
  exports: [NotificationDispatcher, NOTIFICATION_CHANNELS],
})
export class NotificationsModule {}
