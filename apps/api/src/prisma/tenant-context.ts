import { Injectable } from "@nestjs/common";
import { PrismaService, TxClient, tenantStorage } from "./prisma.service";

/**
 * Runs a unit of work inside a transaction whose connection carries
 * `app.current_user_id`, which is the value every RLS policy checks.
 *
 * This is the second of the two isolation layers. The first is the scoped
 * repository, where `businessId` can only come from an ownership check. If a
 * service ever forgets that check, these policies still refuse the rows —
 * the application bug becomes an empty result rather than a data leak.
 */
@Injectable()
export class TenantContext {
  constructor(private readonly prisma: PrismaService) {}

  async withTenant<T>(userId: string, fn: (tx: TxClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // set_config takes bind parameters; `SET LOCAL` does not. Using it
      // keeps the user id out of the SQL string entirely.
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}::text, true)`;
      return tenantStorage.run({ tx, userId }, () => fn(tx));
    });
  }

  /**
   * For work that legitimately has no tenant: the public menu payload, the
   * seed script, health checks. Named so that reaching for it is a visible
   * decision in review rather than an accident.
   */
  async withoutTenant<T>(fn: (client: PrismaService) => Promise<T>): Promise<T> {
    return fn(this.prisma);
  }
}
