import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, from, firstValueFrom } from "rxjs";
import { TenantContext } from "../prisma/tenant-context";
import type { RequestUser } from "../auth/jwt.strategy";

/**
 * Wraps every authenticated request in the transaction that carries
 * `app.current_user_id`, which is what the RLS policies read.
 *
 * Doing this once, globally, is the point. If each service had to remember to
 * open the context itself, the one that forgot would be the one running
 * without any database-level protection — and it would look identical to the
 * ones that did.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly tenant: TenantContext) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context.switchToHttp().getRequest().user as RequestUser | undefined;
    if (!user?.id) return next.handle();

    return from(
      this.tenant.withTenant(user.id, () => firstValueFrom(next.handle())),
    );
  }
}
