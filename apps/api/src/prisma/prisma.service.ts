import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A Prisma client bound to whatever transaction the current request opened.
 *
 * `TenantContext` (tenant-context.ts) opens a transaction per authenticated
 * request and sets `app.current_user_id` on that connection, which is what
 * the RLS policies read. Services must therefore issue their queries on the
 * *transaction* client, not the base one — a query on the base client runs on
 * a different connection where the setting is absent and RLS denies
 * everything.
 *
 * Threading `tx` through every service signature would be noisy and easy to
 * forget, so the active client lives in AsyncLocalStorage and `db` returns it
 * automatically.
 */
export type TxClient = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export const tenantStorage = new AsyncLocalStorage<{ tx: TxClient; userId: string }>();

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * The client every tenant-scoped query should use. Inside a request that
   * went through TenantContext this is the transaction client; outside one
   * (seeds, public endpoints, background work) it is the base client.
   */
  get db(): TxClient {
    return tenantStorage.getStore()?.tx ?? this;
  }

  /** The authenticated user id for the current request, if there is one. */
  get currentUserId(): string | null {
    return tenantStorage.getStore()?.userId ?? null;
  }
}
