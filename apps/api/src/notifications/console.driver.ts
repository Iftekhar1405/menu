import { Injectable, Logger } from "@nestjs/common";
import {
  NotificationChannel,
  OtpPurposeName,
  UserContact,
  otpMessageCopy,
} from "./notification.channel";

/**
 * Stands in for both real channels while no provider credentials exist.
 *
 * It is not a no-op: it implements the same contract and logs the code, so
 * the whole OTP flow — issue, fan-out, verify, expire, lock — is exercised
 * end to end in development and in tests. Swapping in the real drivers is a
 * module wiring change, not a rewrite of anything above it.
 */
@Injectable()
export class ConsoleDriver implements NotificationChannel {
  private readonly logger = new Logger("OTP");

  constructor(readonly name: "whatsapp" | "email") {}

  supports(user: UserContact): boolean {
    return this.name === "email" ? Boolean(user.email) : Boolean(user.phone);
  }

  async sendOtp(user: UserContact, code: string, purpose: OtpPurposeName): Promise<void> {
    const target = this.name === "email" ? user.email : user.phone;
    this.logger.warn(
      `[${this.name}] → ${target}  code=${code}  (${purpose})\n         ${otpMessageCopy(
        code,
        purpose,
      )}`,
    );
  }
}
