import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { loadEnv } from "../config/env";

/**
 * The second authentication principal in the system.
 *
 * An owner JWT says "this person controls this business". A table session says
 * something far narrower: "this device is sitting at table 12 of business X".
 * It can read that business's menu and write to that one table's open order,
 * and nothing else — no other table, no completed order, no /businesses route.
 *
 * Keeping it as a separate principal with its own secret and its own guard is
 * deliberate. If it were a scoped variant of the owner token, a bug in scope
 * checking would hand a diner owner powers; as separate types, an owner token
 * presented to a table route fails to verify at all, and vice versa.
 */

export interface TableSession {
  tableId: string;
  businessId: string;
}

const SESSION_HOURS = 12;

@Injectable()
export class TableSessionService {
  private readonly env = loadEnv();

  constructor(private readonly jwt: JwtService) {}

  async mint(session: TableSession): Promise<string> {
    return this.jwt.signAsync(
      { tid: session.tableId, bid: session.businessId },
      {
        secret: this.env.TABLE_SESSION_SECRET,
        // Long enough for a meal, short enough that someone who scanned at
        // lunch is not still bound to that table at dinner.
        expiresIn: `${SESSION_HOURS}h`,
      },
    );
  }

  async verify(token: string): Promise<TableSession> {
    try {
      const payload = await this.jwt.verifyAsync<{ tid: string; bid: string }>(token, {
        secret: this.env.TABLE_SESSION_SECRET,
      });
      return { tableId: payload.tid, businessId: payload.bid };
    } catch {
      throw new UnauthorizedException("This table session is no longer valid");
    }
  }
}

/**
 * Reads the table session from the Authorization header.
 *
 * The header is set by the Next proxy from an httpOnly cookie — the browser
 * never holds this token itself, so it cannot be lifted by a script and
 * replayed against another table.
 */
@Injectable()
export class TableSessionGuard implements CanActivate {
  constructor(private readonly sessions: TableSessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const header = request.headers.authorization as string | undefined;

    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException("No table session");
    }

    request.tableSession = await this.sessions.verify(header.slice(7));
    return true;
  }
}

export const CurrentTable = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TableSession =>
    ctx.switchToHttp().getRequest().tableSession as TableSession,
);
