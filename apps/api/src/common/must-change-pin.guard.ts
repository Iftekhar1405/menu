import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import type { RequestUser } from "../auth/jwt.strategy";

/**
 * Holds an account that owes a PIN change at the door.
 *
 * Applied globally rather than route by route. The web app gates the shell
 * too, but that is cosmetic — a staff member who never opens the web app can
 * still hold a token, and an owner-chosen PIN is a shared credential until
 * its owner replaces it.
 */
const ALLOWED = new Set(["/auth/pin/change", "/auth/me", "/auth/logout", "/auth/refresh"]);

@Injectable()
export class MustChangePinGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const user = req.user as RequestUser | undefined;
    if (!user?.mustChangePin) return true;

    // Defensive: a trailing slash must not sneak a blocked route past the
    // allow-list, nor wrongly block an allowed one.
    const path: string = typeof req.path === "string" ? req.path : "";
    const normalised = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

    if (ALLOWED.has(normalised)) return true;
    throw new ForbiddenException("Please choose your own PIN before continuing");
  }
}
