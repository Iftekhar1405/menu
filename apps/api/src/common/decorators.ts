import { SetMetadata, createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { RequestUser } from "../auth/jwt.strategy";

export const IS_PUBLIC_KEY = "isPublic";
/** Opts a route out of the global JWT guard. Used by /auth/* and /public/*. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ROLES_KEY = "roles";
/** Restricts a route to given roles, e.g. @Roles('platform_admin'). */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestUser => {
    return ctx.switchToHttp().getRequest().user as RequestUser;
  },
);
