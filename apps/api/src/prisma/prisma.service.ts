import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadEnv } from "../config/env";

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

/**
 * A connection URL with the password stripped, for logs.
 *
 * The username is the interesting part and the reason this exists: a pooled
 * Supabase URL routes by username, so `menu_app` and `menu_app.<project-ref>`
 * are a working connection and a dead one, and the pooler's own error names
 * neither the username nor the variable it came from.
 */
export function describeDatabaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}:${u.port || "5432"}${u.pathname}`;
  } catch {
    return "<unparseable url>";
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** Which variable supplied the connection, for the failure message below. */
  private readonly source: "APP_DATABASE_URL" | "DATABASE_URL";
  private readonly url: string;

  constructor() {
    const env = loadEnv();
    const source = env.APP_DATABASE_URL ? "APP_DATABASE_URL" : "DATABASE_URL";
    const url = env.APP_DATABASE_URL || env.DATABASE_URL;
    super({
      datasources: { db: { url } },
      log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
    this.source = source;
    this.url = url;
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
    } catch (err) {
      // The raw driver error says what the database refused, never which of
      // the two URLs was tried. In a serverless deploy that is the whole
      // question, and the answer is not recoverable from the stack trace.
      this.logger.error(
        `Could not connect using ${this.source} (${describeDatabaseUrl(this.url)})`,
      );

      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOIDENTIFIER")) {
        const user = safeUsername(this.url);
        this.logger.error(
          user.includes(".")
            ? `The pooler rejected the tenant "${user.split(".").pop()}". Check the project ref on ${this.source}.`
            : `The username "${user}" carries no project ref. A pooled Supabase URL needs "${user}.<project-ref>" — fix ${this.source}, not the other one.`,
        );
      }
      throw err;
    }
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

/** The username from a connection URL, or "" if it cannot be parsed. */
function safeUsername(url: string): string {
  try {
    return new URL(url).username;
  } catch {
    return "";
  }
}
