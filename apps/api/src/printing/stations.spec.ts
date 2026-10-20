import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, GoneException, NotFoundException } from "@nestjs/common";
import { StationsService } from "./stations.service";

/**
 * The service against a fake Prisma, because what is being tested is the
 * decisions — who may do what, and what a revoked station answers — not the
 * SQL. The constraints themselves have their own test against a real
 * database in stations-schema.spec.ts.
 */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const station = {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    findMany: vi.fn(),
  };
  const output = { deleteMany: vi.fn() };
  // create() and attachOutput() go through SECURITY DEFINER functions, so
  // what they exercise is $queryRaw, not a model writer. A mock that still
  // offered printStation.create would let a regression back to the ORM path
  // pass silently — and that path is refused by RLS for a kitchen caller.
  // The flat row create()/attachOutput() actually read off `rows[0]!` —
  // not `{ station: {...} }` / `{ output: {...} }`, which was this mock
  // encoding the exact wrong assumption the production bug made. See
  // two-stations.spec.ts's real-database suite for why a mock could not
  // have caught that on its own.
  const queryRaw = vi.fn().mockResolvedValue([{ id: "s1", job: "bill" }]);
  const prisma = { db: { printStation: station, stationOutput: output, $queryRaw: queryRaw } };
  const businesses = {
    assertAccess: vi.fn().mockResolvedValue({ business: { id: "b1" }, role: "owner" }),
  };
  Object.assign(businesses, overrides);
  return {
    svc: new StationsService(prisma as never, businesses as never),
    station,
    output,
    queryRaw,
    businesses,
  };
}

describe("StationsService.resolve", () => {
  it("answers 410 for a revoked station rather than 404", () => {
    // The page must be able to tell "this machine was retired" from "that
    // id was never real" — the first clears localStorage and stops, the
    // second is a bug worth showing.
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: new Date() });
    return expect(svc.resolve("u1", "b1", "s1")).rejects.toBeInstanceOf(GoneException);
  });

  it("404s a station id from another business", () => {
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue(null);
    return expect(svc.resolve("u1", "b1", "s1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refreshes last seen when it resolves", async () => {
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });
    await svc.resolve("u1", "b1", "s1", { touch: true });
    expect(station.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1" } }),
    );
  });

  it("does not touch last seen on a plain read", async () => {
    // "Last seen" must mean the machine asked for work, not that the owner
    // opened the settings page and looked at it.
    const { svc, station } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });
    await svc.resolve("u1", "b1", "s1");
    expect(station.update).not.toHaveBeenCalled();
  });
});

describe("StationsService.attachOutput", () => {
  const output = {
    job: "bill" as const,
    deviceLabel: "EPSON TM-T82",
    deviceKey: "04b8:0202:X",
    transport: "usb" as const,
    paperWidth: 80 as const,
  };

  it("refuses a kitchen user attaching a bill printer", async () => {
    // Review Focus 1. A bill ticket is a payload full of prices, and the
    // kitchen role is stripped of prices everywhere else.
    const { svc, station, businesses } = makeDeps();
    (businesses.assertAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      business: { id: "b1" },
      role: "kitchen",
    });
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });

    await expect(svc.attachOutput("u1", "b1", "s1", output)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("lets a kitchen user attach the kitchen printer", async () => {
    // They are the ones standing next to it. The fake deliberately has no
    // stationOutput.upsert (see the comment on `output` above) — the linking
    // itself goes through attach_station_output, so what this test can
    // honestly assert is that a kitchen caller reaches that function at all
    // for a non-bill job, rather than being turned away by the role check
    // that *does* reject them for "bill" in the test above.
    const { svc, station, output: outputs, queryRaw, businesses } = makeDeps();
    (businesses.assertAccess as ReturnType<typeof vi.fn>).mockResolvedValue({
      business: { id: "b1" },
      role: "kitchen",
    });
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });

    await svc.attachOutput("u1", "b1", "s1", { ...output, job: "kitchen" });

    expect(queryRaw).toHaveBeenCalled();
    expect(outputs).not.toHaveProperty("upsert");
  });

  it("links the printer through the SECURITY DEFINER function, not the ORM", async () => {
    // The table has no kitchen INSERT policy and never will, so the ORM path
    // would be refused by RLS for the people who stand next to the printer.
    // The upsert that makes re-linking a swapped printer work lives inside
    // attach_station_output.
    const { svc, station, output: outputs, queryRaw } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });

    await svc.attachOutput("u1", "b1", "s1", output);

    expect(queryRaw).toHaveBeenCalled();
    const sql = String(queryRaw.mock.calls[0]![0]);
    expect(sql).toContain("attach_station_output");
    expect(outputs).not.toHaveProperty("upsert");
  });

  it("creates a station through the function too", async () => {
    const { svc, queryRaw } = makeDeps();
    await svc.create("u1", "b1", "Counter");
    expect(String(queryRaw.mock.calls[0]![0])).toContain("create_print_station");
  });

  it("passes the values it was given, not just the right function name", async () => {
    // Checking the SQL text alone only catches a typo in the function name.
    // A swapped businessId/stationId would still name attach_station_output
    // correctly while writing against the wrong venue's row — this checks
    // what was actually interpolated into the call.
    const { svc, station, queryRaw } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s7", businessId: "b9", revokedAt: null });

    await svc.attachOutput("u1", "b9", "s7", output);

    const [, ...values] = queryRaw.mock.calls[0]!;
    expect(values).toEqual([
      "b9",
      "s7",
      output.job,
      output.deviceLabel,
      output.deviceKey,
      output.transport,
      output.paperWidth,
    ]);
  });

  it("turns a function's refusal into a status rather than a 500", async () => {
    // Reachable, not theoretical: an owner can revoke a station in the
    // window between resolve() checking it and this $queryRaw running.
    // Without error mapping, attach_station_output's own RAISE EXCEPTION
    // arrives as raw Postgres text and Nest answers 500.
    const { svc, station, queryRaw } = makeDeps();
    station.findFirst.mockResolvedValue({ id: "s1", businessId: "b1", revokedAt: null });
    queryRaw.mockRejectedValueOnce(new Error("ERROR: no such station"));

    await expect(svc.attachOutput("u1", "b1", "s1", output)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe("StationsService.revoke", () => {
  it("revokes only within the business named in the URL", async () => {
    // RLS does not object when an owner's two venues both belong to them —
    // only the URL's :bid says which shop this request is about.
    const { svc, station } = makeDeps();
    await svc.revoke("u1", "b1", "s1");
    expect(station.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "s1", businessId: "b1" } }),
    );
  });

  it("404s when the pairing matches nothing", async () => {
    // Venue A's :bid paired with venue B's station id: the owner reaches
    // both, so RLS allows the update, but it should touch nothing here.
    const { svc, station } = makeDeps();
    station.updateMany.mockResolvedValue({ count: 0 });
    return expect(svc.revoke("u1", "b1", "s1")).rejects.toBeInstanceOf(NotFoundException);
  });
});
