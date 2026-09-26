import { Inject, Injectable, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export interface Liveness {
  status: "ok";
  /** How long this process — or, on Vercel, this warm instance — has been up. */
  uptimeSeconds: number;
  /** The deployed commit, when the platform tells us. */
  revision: string | null;
  startedAt: string;
}

export interface DependencyCheck {
  status: "ok" | "down";
  latencyMs: number;
  error?: string;
}

export interface Readiness {
  status: "ok" | "down";
  checks: { database: DependencyCheck };
}

/** Long enough to survive a slow hosted database, short enough to be an answer. */
const DEFAULT_DB_TIMEOUT_MS = 5_000;

/**
 * Optional override for the database check's deadline. Nothing provides it
 * today; it exists so a deployment on a slower link can raise the limit, and
 * so a test can shorten it, without either reaching into the class.
 */
export const HEALTH_DB_TIMEOUT_MS = Symbol("HEALTH_DB_TIMEOUT_MS");

/**
 * Two questions that look like one.
 *
 * **Liveness** asks whether the process is running. It must not touch the
 * database, because the consumer of that answer is something with the power
 * to restart the API — and restarting the API does not fix Postgres. It
 * turns a recoverable dependency outage into an outage plus a cold start,
 * and it kills the one endpoint that could have explained what was wrong.
 *
 * **Readiness** asks whether the API can currently do its job, which here
 * means reaching the database. A load balancer draining traffic on this is
 * correct; a supervisor killing the process on it is not.
 */
@Injectable()
export class HealthService {
  private readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    // @Optional, because Nest resolves constructor parameters by type and a
    // bare `number` with a default is not something it can inject — it looks
    // for a `Number` provider and fails to boot. Unprovided, this arrives
    // undefined and the default applies.
    @Optional()
    @Inject(HEALTH_DB_TIMEOUT_MS)
    private readonly dbTimeoutMs: number = DEFAULT_DB_TIMEOUT_MS,
  ) {}

  live(): Liveness {
    return {
      status: "ok",
      uptimeSeconds: Math.round(process.uptime()),
      // Vercel sets this on every deployment; locally there is no answer and
      // claiming one would be worse than null.
      revision: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      startedAt: this.startedAt.toISOString(),
    };
  }

  async ready(): Promise<Readiness> {
    const database = await this.checkDatabase();
    return {
      status: database.status === "ok" ? "ok" : "down",
      checks: { database },
    };
  }

  /**
   * `select 1` rather than a real query: this is asking whether a connection
   * can be acquired and a round trip completed, not whether any particular
   * table is readable. It also touches no table, so it is unaffected by the
   * row-level security that governs every other query in the API.
   */
  private async checkDatabase(): Promise<DependencyCheck> {
    const started = Date.now();
    try {
      await this.withTimeout(this.prisma.$queryRaw`select 1`);
      return { status: "ok", latencyMs: Date.now() - started };
    } catch (err) {
      return {
        status: "down",
        latencyMs: Date.now() - started,
        error: redact(err),
      };
    }
  }

  /**
   * A health check that hangs is worse than one that fails: the monitor
   * waiting on it reports nothing at all, which reads as "still checking"
   * rather than "the database is gone". An exhausted connection pool hangs
   * exactly like this.
   */
  private withTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Database check timed out after ${this.dbTimeoutMs}ms`)),
        this.dbTimeoutMs,
      );
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
}

/**
 * Health endpoints are usually the most public thing an API exposes, and
 * Prisma's connection errors quote the connection URL — password included.
 * Strip anything URL-shaped before the message goes anywhere near a response.
 */
function redact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}
