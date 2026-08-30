import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { loadEnv } from "../config/env";
import { PrismaService } from "../prisma/prisma.service";
import type { AccessPayload } from "./token.service";

export interface RequestUser {
  id: string;
  role: string;
  verified: boolean;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: loadEnv().JWT_ACCESS_SECRET,
    });
  }

  /**
   * The token is re-checked against the database on every request rather than
   * trusted on its own. A 15-minute window is short, but not short enough to
   * let a deleted account keep working, and the row is needed for the
   * verified flag anyway.
   */
  async validate(payload: AccessPayload): Promise<RequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, role: true, verifiedAt: true },
    });
    if (!user) throw new UnauthorizedException("Session is no longer valid");

    return { id: user.id, role: user.role, verified: user.verifiedAt !== null };
  }
}
