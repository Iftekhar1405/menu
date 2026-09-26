import { describe, expect, it, vi } from "vitest";
import { HealthService } from "./health.service";
import type { PrismaService } from "../prisma/prisma.service";

/**
 * The distinction these tests exist to protect: liveness must never depend on
 * the database. A platform that restarts the API because Postgres is briefly
 * unreachable turns a recoverable outage into a longer one, and takes the
 * endpoint that would have explained it down too.
 */

function prismaThat(
  behaviour: () => Promise<unknown>,
): PrismaService {
  return { $queryRaw: vi.fn(behaviour) } as unknown as PrismaService;
}

const reachable = () => prismaThat(async () => [{ ok: 1 }]);
const unreachable = () =>
  prismaThat(async () => {
    throw new Error("Can't reach database server at db.example.com:5432");
  });

describe("HealthService", () => {
  describe("live", () => {
    it("reports ok", () => {
      expect(new HealthService(reachable()).live().status).toBe("ok");
    });

    it("never touches the database", () => {
      const prisma = unreachable();
      const health = new HealthService(prisma);

      expect(health.live().status).toBe("ok");
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it("reports how long this instance has been up", () => {
      expect(new HealthService(reachable()).live().uptimeSeconds).toBeGreaterThanOrEqual(0);
    });
  });

  describe("ready", () => {
    it("is ok when the database answers", async () => {
      const result = await new HealthService(reachable()).ready();

      expect(result.status).toBe("ok");
      expect(result.checks.database.status).toBe("ok");
      expect(result.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("is down when the database refuses", async () => {
      const result = await new HealthService(unreachable()).ready();

      expect(result.status).toBe("down");
      expect(result.checks.database.status).toBe("down");
    });

    it("says what went wrong without leaking the connection string", async () => {
      const prisma = prismaThat(async () => {
        throw new Error(
          "Authentication failed against database server at `db.example.com`, the provided database credentials for `menu_app` are not valid. postgresql://menu_app:hunter2@db.example.com:5432/postgres",
        );
      });

      const result = await new HealthService(prisma).ready();

      expect(result.checks.database.error).toBeTruthy();
      expect(result.checks.database.error).not.toContain("hunter2");
      expect(result.checks.database.error).not.toContain("postgresql://");
    });

    it("gives up rather than hanging when the database never answers", async () => {
      vi.useFakeTimers();
      try {
        const prisma = prismaThat(() => new Promise(() => {}));
        const health = new HealthService(prisma, 5_000);

        const pending = health.ready();
        await vi.advanceTimersByTimeAsync(5_001);
        const result = await pending;

        expect(result.status).toBe("down");
        expect(result.checks.database.error).toMatch(/timed out/i);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not report a failure as merely slow", async () => {
      const result = await new HealthService(unreachable()).ready();
      expect(result.checks.database.error).not.toMatch(/timed out/i);
    });
  });
});
