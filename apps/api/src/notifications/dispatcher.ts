import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  AllChannelsFailedError,
  NOTIFICATION_CHANNELS,
  NoChannelsAvailableError,
  NotificationChannel,
  OtpPurposeName,
  UserContact,
} from "./notification.channel";

export interface FanOutResult {
  /** Channels that accepted the message. */
  dispatched: string[];
  /** Channels that were tried and failed. Not an error unless all failed. */
  failed: { channel: string; reason: string }[];
}

/**
 * Sends one code to every channel the account has.
 *
 * The fan-out is deliberate rather than a fallback chain. A WhatsApp message
 * that fails to deliver fails *silently* from the owner's point of view —
 * nothing bounces, the message simply never arrives — so waiting for it to
 * time out before trying email would strand people. Sending both at once and
 * tolerating partial failure means the owner reads whichever arrives first.
 */
@Injectable()
export class NotificationDispatcher {
  private readonly logger = new Logger(NotificationDispatcher.name);

  constructor(
    @Inject(NOTIFICATION_CHANNELS)
    private readonly channels: NotificationChannel[],
  ) {}

  async fanOutOtp(
    user: UserContact,
    code: string,
    purpose: OtpPurposeName,
  ): Promise<FanOutResult> {
    const usable = this.channels.filter((c) => c.supports(user));
    if (usable.length === 0) throw new NoChannelsAvailableError();

    const settled = await Promise.allSettled(
      usable.map((c) => c.sendOtp(user, code, purpose)),
    );

    const dispatched: string[] = [];
    const failed: { channel: string; reason: string }[] = [];

    settled.forEach((result, i) => {
      const channel = usable[i]!.name;
      if (result.status === "fulfilled") {
        dispatched.push(channel);
      } else {
        const reason =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        failed.push({ channel, reason });
        this.logger.warn(`OTP delivery failed on ${channel}: ${reason}`);
      }
    });

    // Only a total failure is worth surfacing. One channel landing is enough
    // for the owner to complete the flow.
    if (dispatched.length === 0) throw new AllChannelsFailedError(failed);

    return { dispatched, failed };
  }
}
