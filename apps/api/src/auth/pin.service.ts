import { BadRequestException, Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

/**
 * The 6-digit PIN is the only credential in this system, which means the
 * hashing parameters matter more than they normally would. A 6-digit space is
 * one million candidates; the cost below is chosen so that exhausting it
 * offline is expensive rather than instant.
 *
 * This does not make a 6-digit PIN safe on its own — see the accepted-risk
 * note in the design doc. It buys time, not immunity.
 */
const ARGON_OPTS = {
  // OWASP-recommended floor for argon2id, raised on memory since our
  // keyspace is small and we can afford ~64MB per login.
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

const SIX_DIGITS = /^\d{6}$/;

@Injectable()
export class PinService {
  assertValidPin(pin: string): void {
    if (!SIX_DIGITS.test(pin)) {
      throw new BadRequestException("PIN must be exactly 6 digits");
    }
  }

  async hashPin(pin: string): Promise<string> {
    this.assertValidPin(pin);
    return hash(pin, ARGON_OPTS);
  }

  /**
   * Never throws on a bad hash — a malformed stored hash must read as "wrong
   * PIN" rather than a 500 that tells an attacker the account exists.
   */
  async verifyPin(pin: string, storedHash: string): Promise<boolean> {
    if (!SIX_DIGITS.test(pin)) return false;
    try {
      return await verify(storedHash, pin);
    } catch {
      return false;
    }
  }

  /** Hashes an OTP code with the same parameters. Codes are equally short. */
  async hashCode(code: string): Promise<string> {
    return hash(code, ARGON_OPTS);
  }

  async verifyCode(code: string, storedHash: string): Promise<boolean> {
    try {
      return await verify(storedHash, code);
    } catch {
      return false;
    }
  }
}
