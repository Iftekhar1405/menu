import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { createHash, randomBytes } from "node:crypto";
import type { UserRole } from "@prisma/client";
import { loadEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";

export const ACCESS_TTL = "15m";
const REFRESH_TTL_DAYS = 30;

export interface AccessPayload {
  sub: string;
  role: UserRole;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/**
 * Access tokens are short-lived JWTs; refresh tokens are opaque random
 * strings stored as SHA-256 digests and rotated on every use.
 *
 * Rotation matters here more than usual. The only other credential is a
 * six-digit PIN, so a stolen long-lived refresh token would be the softest
 * way into an account. Rotating means a stolen token works at most once, and
 * reuse of an already-rotated token is detectable.
 */
@Injectable()
export class TokenService {
  private readonly env = loadEnv();

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async issue(userId: string, role: UserRole): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, role } satisfies AccessPayload,
      { secret: this.env.JWT_ACCESS_SECRET, expiresIn: ACCESS_TTL },
    );

    const refreshToken = randomBytes(48).toString("base64url");
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86_400_000);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: refreshExpiresAt,
      },
    });

    return { accessToken, refreshToken, refreshExpiresAt };
  }

  async rotate(presented: string): Promise<IssuedTokens> {
    const tokenHash = this.hashToken(presented);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException("Session expired. Please sign in again.");
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issue(stored.userId, stored.user.role);
  }

  async revoke(presented: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(presented), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Called on PIN change: every existing session dies with the old PIN. */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
