import {
  BadRequestException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { PrintStation, StationOutput } from "@prisma/client";
import type { StationOutputInput } from "@menu/shared";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";
import { cleanPgMessage } from "../common/pg-message";

/** Who may reach a station at all. Narrowed per job in attachOutput. */
const STATION_ROLES = { allow: ["owner", "kitchen"] as const };

/**
 * Turns a SECURITY DEFINER function's RAISE EXCEPTION into an HTTP status,
 * the same precedent as `place_table_round`'s own catch
 * (orders.service.ts:88-103). `create_print_station` and
 * `attach_station_output` re-check the caller themselves — RLS is not going
 * to — and raise exactly two messages by hand:
 *
 *  - "not your business": the caller has no access to this business at all.
 *  - "no such station": attach_station_output's own existence check. This is
 *    reachable, not theoretical — an owner can revoke a station in the
 *    window between resolve() seeing it live and this call reaching
 *    Postgres.
 *
 * Anything else that looks like a RAISE EXCEPTION becomes a 400 with the
 * message cleaned up for a person, same as every other SQL-raised error in
 * this API. Without this wrapper both functions' own guards arrive as raw
 * Postgres text and Nest answers 500.
 */
async function fromFunction<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/not your business/.test(message)) {
      throw new ForbiddenException("Not your business");
    }
    if (/no such station/.test(message)) {
      throw new NotFoundException("Station not found");
    }
    const match = /ERROR: (.+)/.exec(message);
    if (match) throw new BadRequestException(cleanPgMessage(match[1]!));
    throw err;
  }
}

@Injectable()
export class StationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
  ) {}

  /**
   * A station id from a URL or from localStorage, turned into a row.
   *
   * Three outcomes, and the difference between the last two matters to the
   * page: a station of another business is 404 (that it exists is not
   * something a stranger needs confirmed), and a revoked one is 410, which
   * is the page's signal to clear its localStorage and stop asking.
   *
   * `touch` is passed only by the endpoints a working station calls, so
   * "last seen" means the machine asked for work — not that the owner
   * opened the settings page and looked at it.
   */
  async resolve(
    userId: string,
    businessId: string,
    stationId: string,
    opts: { touch?: boolean } = {},
  ) {
    await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });

    // Outputs come along: every caller of resolve() needs to know which
    // jobs this machine has a printer for, and a second round trip for a
    // row we already have is waste on a path polled every ten seconds.
    const station = await this.prisma.db.printStation.findFirst({
      where: { id: stationId, businessId },
      include: { outputs: true },
    });
    if (!station) throw new NotFoundException("Station not found");
    if (station.revokedAt) throw new GoneException("This machine is no longer a station");

    if (opts.touch) {
      await this.prisma.db.printStation.update({
        where: { id: stationId },
        data: { lastSeenAt: new Date() },
      });
    }
    return station;
  }

  /**
   * Through `create_print_station`, not `printStation.create`.
   *
   * There is no kitchen INSERT policy on this table and there deliberately
   * never will be — see the invariant in kitchen-policies.spec.ts. The
   * SECURITY DEFINER function is the only door, and it re-checks the caller
   * itself because RLS is not going to.
   */
  async create(userId: string, businessId: string, name: string) {
    await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    const rows = await fromFunction(() =>
      this.prisma.db.$queryRaw<
        { station: PrintStation }[]
      >`SELECT create_print_station(${businessId}::uuid, ${name}) AS station`,
    );
    return rows[0]!.station;
  }

  async list(userId: string, businessId: string) {
    await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    return this.prisma.db.printStation.findMany({
      where: { businessId, revokedAt: null },
      include: { outputs: true },
      orderBy: { createdAt: "asc" },
    });
  }

  async rename(userId: string, businessId: string, stationId: string, name: string) {
    await this.resolve(userId, businessId, stationId);
    return this.prisma.db.printStation.update({ where: { id: stationId }, data: { name } });
  }

  /**
   * Revoked, not deleted: the receipts pointing at it are the record.
   *
   * Scoped to `businessId` as well as `stationId` — RLS alone does not
   * object to the mismatch when an owner has two venues: a station id from
   * venue B against venue A's `:bid` in the URL is still a row that owner
   * may write. Without this, that pairing silently revokes a machine in a
   * shop nobody asked about, and nothing tells the caller why.
   */
  async revoke(userId: string, businessId: string, stationId: string) {
    await this.businesses.assertAccess(userId, businessId, { allow: ["owner"] });
    const { count } = await this.prisma.db.printStation.updateMany({
      where: { id: stationId, businessId },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException("Station not found");
  }

  /**
   * Link a printer to one of this station's jobs.
   *
   * An upsert, because re-linking is the normal repair when a printer is
   * swapped and the unique (station, job) index means a second row cannot
   * exist anyway.
   *
   * A `bill` output is owner-only. The database refuses it too (see
   * station_outputs_bill_guard); this is the half that produces a 403 with
   * a sentence in it rather than a Postgres error.
   */
  async attachOutput(
    userId: string,
    businessId: string,
    stationId: string,
    body: StationOutputInput,
  ) {
    const { role } = await this.businesses.assertAccess(userId, businessId, {
      allow: [...STATION_ROLES.allow],
    });
    if (body.job === "bill" && role !== "owner") {
      throw new ForbiddenException("Only the owner can put a bill printer on a machine");
    }
    await this.resolve(userId, businessId, stationId);

    // Same door as create(): the upsert lives inside attach_station_output,
    // which is also what makes re-linking a swapped printer work.
    const rows = await fromFunction(() =>
      this.prisma.db.$queryRaw<{ output: StationOutput }[]>`
      SELECT attach_station_output(
        ${businessId}::uuid, ${stationId}::uuid, ${body.job}::"PrintJob",
        ${body.deviceLabel}, ${body.deviceKey}, ${body.transport}::"PrintTransport",
        ${body.paperWidth}::smallint
      ) AS output`,
    );
    return rows[0]!.output;
  }

  /**
   * Owner-only, and not for tidiness: the schema has no kitchen DELETE
   * policy, by the same invariant that keeps the kitchen off INSERT. A
   * kitchen user who linked the wrong printer re-links it — that is an
   * upsert through attach_station_output, not a delete.
   */
  async detachOutput(userId: string, businessId: string, stationId: string, job: string) {
    await this.businesses.assertAccess(userId, businessId, { allow: ["owner"] });
    await this.prisma.db.stationOutput.deleteMany({
      where: { stationId, businessId, job: job as never },
    });
  }
}
