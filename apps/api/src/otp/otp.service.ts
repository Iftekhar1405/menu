import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { OtpPurpose } from "@prisma/client";
import { TooManyRequestsException } from "../common/exceptions";
import { randomInt } from "node:crypto";
import { PinService } from "../auth/pin.service";
    import { NotificationDispatcher } from "src/otp/channels/dispatcher";
import { PrismaService } from "../prisma/prisma.service";
import { UserContact } from "./channels/notification.channel";

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** Minimum gap between resends, so the button cannot be used as an SMS gun. */
const RESEND_COOLDOWN_SECONDS = 60;

export interface IssueResult {
  dispatched: string[];
  expiresAt: Date;
}

/**
 * One code per challenge, fanned out to every channel the account has.
 *
 * The code is stored hashed with the same parameters as the PIN. A six-digit
 * code in a database is a credential; there is no reason for it to be
 * readable by anyone with a SELECT.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pins: PinService,
    private readonly dispatcher: NotificationDispatcher,
  ) {}

  async issue(user: UserContact, purpose: OtpPurpose): Promise<IssueResult> {
    const recent = await this.prisma.otpChallenge.findFirst({
      where: { userId: user.id, purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });

    if (recent) {
      const ageSeconds = (Date.now() - recent.createdAt.getTime()) / 1000;
      if (ageSeconds < RESEND_COOLDOWN_SECONDS) {
        throw new TooManyRequestsException(
          `Wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - ageSeconds)} seconds before asking for another code`,
        );
      }
    }

    // randomInt is CSPRNG-backed. Math.random would be guessable.
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const codeHash = await this.pins.hashCode(code);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000);

    // Supersede any outstanding challenge for this purpose — two live codes
    // for one account is a needless widening of the guessing surface.
    await this.prisma.otpChallenge.updateMany({
      where: { userId: user.id, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await this.prisma.otpChallenge.create({
      data: { userId: user.id, purpose, codeHash, expiresAt },
    });

    const { dispatched, failed } = await this.dispatcher.fanOutOtp(user, code, purpose);
    if (failed.length > 0) {
      this.logger.warn(
        `OTP for ${user.id} delivered on [${dispatched.join(", ")}], failed on [${failed
          .map((f) => f.channel)
          .join(", ")}]`,
      );
    }

    return { dispatched, expiresAt };
  }

  /**
   * Returns true only for a live, unconsumed, correct code. Every failure
   * path burns an attempt, so brute-forcing a live code costs five tries.
   */
  async verify(userId: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { userId, purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });

    if (!challenge) {
      throw new BadRequestException("Ask for a new code — this one is no longer valid");
    }

    if (challenge.expiresAt.getTime() < Date.now()) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw new BadRequestException("That code has expired. Ask for a new one.");
    }

    if (challenge.attempts >= MAX_ATTEMPTS) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { consumedAt: new Date() },
      });
      throw new TooManyRequestsException(
        "Too many incorrect codes. Ask for a new one.",
      );
    }

    const ok = await this.pins.verifyCode(code, challenge.codeHash);

    if (!ok) {
      await this.prisma.otpChallenge.update({
        where: { id: challenge.id },
        data: { attempts: { increment: 1 } },
      });
      return false;
    }

    await this.prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { consumedAt: new Date() },
    });
    return true;
  }
}
