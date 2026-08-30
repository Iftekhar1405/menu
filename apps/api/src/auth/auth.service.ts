import {
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import type { OtpPurpose, User } from "@prisma/client";
import type {
  LoginInput,
  OtpRequestInput,
  PinResetInput,
  SignupInput,
} from "@menu/shared";
import { TooManyRequestsException } from "../common/exceptions";
import { loadEnv } from "../config/env";
import { generatePublicCode } from "../businesses/public-code";
import { OtpService } from "../otp/otp.service";
import { PrismaService } from "../prisma/prisma.service";
import { Identifier, identifierWhere, maskIdentifier, parseIdentifier } from "./identifier";
import { PinService } from "./pin.service";
import { IssuedTokens, TokenService } from "./token.service";

/**
 * Failed-attempt policy. The PIN is a six-digit secret and the only factor,
 * so online guessing has to be made expensive: five wrong tries earns a
 * cooling-off period that doubles, and ten locks the account until an OTP
 * recovery. A million-candidate keyspace is only safe if an attacker cannot
 * take many shots at it.
 */
const BACKOFF_AFTER = 5;
const LOCKOUT_AFTER = 10;
const BASE_BACKOFF_SECONDS = 30;

export interface AuthResult extends IssuedTokens {
  user: { id: string; fullName: string; role: string; verified: boolean };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly env = loadEnv();
  /**
   * Verified against when no account matches, so a wrong identifier costs the
   * same wall-clock time as a wrong PIN. Without this, response timing
   * answers "does this phone number have an account?" for free.
   */
  private decoyHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pins: PinService,
    private readonly tokens: TokenService,
    private readonly otp: OtpService,
  ) {
    this.decoyHash = this.pins.hashPin("000000");
  }

  // ── Signup ────────────────────────────────────────────────────────────────

  async signup(input: SignupInput): Promise<AuthResult> {
    const identifier = parseIdentifier(input.identifier, input.country);

    const existing = await this.prisma.user.findFirst({
      where: identifierWhere(identifier),
    });
    if (existing) {
      throw new ConflictException(
        identifier.kind === "email"
          ? "An account already uses that email address"
          : "An account already uses that phone number",
      );
    }

    const pinHash = await this.pins.hashPin(input.pin);
    const skipVerification = this.env.AUTH_SKIP_VERIFICATION;

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: identifier.kind === "email" ? identifier.email : null,
          phone: identifier.kind === "phone" ? identifier.phone : null,
          pinHash,
          fullName: input.fullName,
          // No credentials are configured, so verification is bypassed and
          // the account starts usable. Flipping AUTH_SKIP_VERIFICATION to
          // false is all that is needed to require a real OTP.
          verifiedAt: skipVerification ? new Date() : null,
        },
      });

      // The connection has no tenant context yet — signup runs before there
      // is anyone to be. Adopt the identity we just created so the business
      // insert satisfies the same RLS policy every later write goes through,
      // rather than carving out an exemption for signup.
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${created.id}::text, true)`;

      await tx.business.create({
        data: {
          ownerId: created.id,
          name: input.businessName,
          type: input.businessType,
          country: input.country,
          publicCode: await this.mintPublicCode(tx),
        },
      });

      return created;
    });

    if (!skipVerification) {
      // Delivery failure must not strand a new account — they can ask for
      // another code from the verification screen.
      await this.otp.issue(toContact(user), "verify").catch((err: unknown) => {
        this.logger.warn(`Could not send signup OTP to ${user.id}: ${String(err)}`);
      });
    }

    return this.buildResult(user);
  }

  /** Retries on the astronomically unlikely collision rather than 500ing. */
  private async mintPublicCode(
    tx: { business: { findUnique: (a: never) => Promise<unknown> } } | any,
  ): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = generatePublicCode();
      const clash = await tx.business.findUnique({ where: { publicCode: code } });
      if (!clash) return code;
    }
    throw new Error("Could not mint a unique public code");
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async login(input: LoginInput): Promise<AuthResult> {
    const identifier = parseIdentifier(input.identifier, input.country ?? "IN");
    const user = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });

    if (!user) {
      // Burn the same time an argon2 verify would, then fail identically to
      // a wrong PIN. The caller cannot tell the two apart.
      await this.pins.verifyPin(input.pin, await this.decoyHash);
      throw new UnauthorizedException("That identifier and PIN do not match");
    }

    this.assertNotLocked(user);

    const ok = await this.pins.verifyPin(input.pin, user.pinHash);
    if (!ok) {
      await this.registerFailure(user);
      throw new UnauthorizedException("That identifier and PIN do not match");
    }

    if (user.failedAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedAttempts: 0, lockedUntil: null },
      });
    }

    return this.buildResult(user);
  }

  private assertNotLocked(user: User): void {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      throw new TooManyRequestsException(
        seconds > 300
          ? "This account is locked. Reset your PIN to get back in."
          : `Too many attempts. Try again in ${seconds} seconds.`,
        seconds,
      );
    }
  }

  private async registerFailure(user: User): Promise<void> {
    const attempts = user.failedAttempts + 1;
    let lockedUntil: Date | null = null;

    if (attempts >= LOCKOUT_AFTER) {
      // Effectively indefinite: recovery is via OTP, not waiting.
      lockedUntil = new Date(Date.now() + 24 * 3_600_000);
    } else if (attempts >= BACKOFF_AFTER) {
      const doublings = attempts - BACKOFF_AFTER;
      lockedUntil = new Date(Date.now() + BASE_BACKOFF_SECONDS * 2 ** doublings * 1000);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedAttempts: attempts, lockedUntil },
    });
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async refresh(presented: string): Promise<IssuedTokens> {
    return this.tokens.rotate(presented);
  }

  async logout(presented: string | undefined): Promise<void> {
    if (presented) await this.tokens.revoke(presented);
  }

  // ── OTP ───────────────────────────────────────────────────────────────────

  /**
   * Always reports success. Telling an anonymous caller "no account has that
   * number" turns this endpoint into an account-enumeration oracle.
   */
  async requestOtp(input: OtpRequestInput): Promise<{ sentTo: string | null }> {
    const identifier = parseIdentifier(input.identifier, input.country ?? "IN");
    const user = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });

    if (!user) {
      this.logger.log(`OTP requested for unknown identifier (${identifier.kind})`);
      return { sentTo: maskIdentifier(identifier) };
    }

    await this.otp.issue(toContact(user), input.purpose as OtpPurpose);
    return { sentTo: maskIdentifier(identifier) };
  }

  async verifyOtp(
    identifierRaw: string,
    purpose: OtpPurpose,
    code: string,
    country = "IN",
  ): Promise<boolean> {
    const identifier = parseIdentifier(identifierRaw, country);
    const user = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });
    if (!user) throw new UnauthorizedException("That code is not valid");

    const ok = await this.otp.verify(user.id, purpose, code);
    if (ok && purpose === "verify" && !user.verifiedAt) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { verifiedAt: new Date() },
      });
    }
    return ok;
  }

  // ── PIN reset ─────────────────────────────────────────────────────────────

  async resetPin(input: PinResetInput): Promise<void> {
    const identifier = parseIdentifier(input.identifier, input.country ?? "IN");
    const user = await this.prisma.user.findFirst({ where: identifierWhere(identifier) });
    if (!user) throw new UnauthorizedException("That code is not valid");

    const ok = await this.otp.verify(user.id, "recover", input.code);
    if (!ok) throw new UnauthorizedException("That code is not valid");

    const pinHash = await this.pins.hashPin(input.newPin);
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        pinHash,
        failedAttempts: 0,
        lockedUntil: null,
        // Completing an OTP proves control of a channel, so this doubles as
        // verification for an account that never finished it.
        verifiedAt: user.verifiedAt ?? new Date(),
      },
    });

    // A PIN change must not leave older sessions alive.
    await this.tokens.revokeAllForUser(user.id);
  }

  // ── Shared ────────────────────────────────────────────────────────────────

  private async buildResult(user: User): Promise<AuthResult> {
    const issued = await this.tokens.issue(user.id, user.role);
    return {
      ...issued,
      user: {
        id: user.id,
        fullName: user.fullName,
        role: user.role,
        verified: user.verifiedAt !== null,
      },
    };
  }
}

function toContact(user: User) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    phone: user.phone,
  };
}

export type { Identifier };
