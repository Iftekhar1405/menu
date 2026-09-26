import { describe, expect, it } from "vitest";
import { TENANT_TX_MAX_WAIT_MS, TENANT_TX_TIMEOUT_MS, TenantContext } from "./tenant-context";

interface Recorded {
  options?: { timeout?: number; maxWait?: number };
  sql: string[];
  params: unknown[][];
}

/**
 * A stand-in for Prisma that records how the transaction was opened. The
 * transaction options are the behaviour under test here: with the database a
 * few hundred milliseconds away, Prisma's 5s default expires part-way through
 * an ordinary write and the whole request rolls back.
 */
function fakePrisma(): { prisma: unknown; recorded: Recorded } {
  const recorded: Recorded = { sql: [], params: [] };

  const tx = {
    $executeRaw: (strings: TemplateStringsArray, ...params: unknown[]) => {
      recorded.sql.push(strings.join("?"));
      recorded.params.push(params);
      return Promise.resolve(1);
    },
  };

  const prisma = {
    $transaction: (fn: (t: unknown) => Promise<unknown>, options?: Recorded["options"]) => {
      recorded.options = options;
      return fn(tx);
    },
  };

  return { prisma, recorded };
}

describe("TenantContext.withTenant", () => {
  it("does not leave the transaction on Prisma's 5s default", () => {
    // Twelve round trips at ~400ms is an ordinary menu-item write against a
    // remote database, and that alone exceeds five seconds.
    expect(TENANT_TX_TIMEOUT_MS).toBeGreaterThan(5000);
  });

  it("opens the transaction with the explicit timeout, not the default", async () => {
    const { prisma, recorded } = fakePrisma();

    await new TenantContext(prisma as never).withTenant("u1", async () => "done");

    expect(recorded.options?.timeout).toBeGreaterThan(5000);
    expect(recorded.options?.timeout).toBe(TENANT_TX_TIMEOUT_MS);
    expect(recorded.options?.maxWait).toBe(TENANT_TX_MAX_WAIT_MS);
  });

  it("still binds the user id for the RLS policies to read", async () => {
    const { prisma, recorded } = fakePrisma();

    await new TenantContext(prisma as never).withTenant("user-42", async () => null);

    expect(recorded.sql[0]).toContain("app.current_user_id");
    expect(recorded.params[0]).toEqual(["user-42"]);
  });

  it("returns what the unit of work returned", async () => {
    const { prisma } = fakePrisma();

    const result = await new TenantContext(prisma as never).withTenant("u1", async () => ({
      ok: true,
    }));

    expect(result).toEqual({ ok: true });
  });
});
