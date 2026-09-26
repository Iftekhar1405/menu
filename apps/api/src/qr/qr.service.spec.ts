import { NotFoundException } from "@nestjs/common";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * QrService reads the environment in a field initialiser, so this has to be
 * in place before the class is constructed — and loadEnv caches, so it has to
 * be in place before anything else in the process calls it.
 */
beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://localhost:5432/test",
    JWT_ACCESS_SECRET: "test-secret-value",
    JWT_REFRESH_SECRET: "test-secret-value",
    REVALIDATE_SECRET: "test-secret-value",
    TABLE_SESSION_SECRET: "test-secret-value",
    PUBLIC_MENU_BASE_URL: "http://localhost:3000",
  });
});

const BUSINESS = {
  id: "b1",
  name: "Blue Tokai",
  publicCode: "bluetokai",
  logoPath: null,
  themeAccent: "#1D6F5C",
};

function tableRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    businessId: BUSINESS.id,
    label: `Table ${i + 1}`,
    token: `token${i}`,
    position: i,
  }));
}

/** Builds the service with just enough around it to render a sheet. */
async function makeService(rows: ReturnType<typeof tableRows>) {
  const { QrService } = await import("./qr.service");

  const prisma = {
    db: {
      table: {
        findMany: async ({ where }: { where: { id: { in: string[] }; businessId: string } }) =>
          rows.filter((r) => where.id.in.includes(r.id) && r.businessId === where.businessId),
      },
    },
  };

  return new QrService(
    { assertOwns: async () => BUSINESS } as never,
    {} as never,
    {} as never,
    prisma as never,
  );
}

function pageCount(pdf: Buffer): number {
  const m = /\/Count (\d+)/.exec(pdf.toString("latin1"));
  if (!m) throw new Error("no page tree in the PDF");
  return Number(m[1]);
}

const SHEET = {
  paper: "a4",
  orientation: "portrait",
  size: "medium",
  style: "compact",
} as const;

describe("QrService.tableSheetPdf", () => {
  it("spills onto a second page once the first is full", async () => {
    const rows = tableRows(7);
    const qr = await makeService(rows);

    const pdf = await qr.tableSheetPdf("u1", BUSINESS.id, {
      ...SHEET,
      tableIds: rows.map((r) => r.id),
    });

    // Six compact medium cells fit a portrait A4; the seventh starts page two.
    expect(pageCount(pdf)).toBe(2);
  });

  it("refuses a table that does not belong to the business", async () => {
    const rows = tableRows(2);
    const qr = await makeService(rows);

    await expect(
      qr.tableSheetPdf("u1", BUSINESS.id, {
        ...SHEET,
        tableIds: ["t0", "someone-elses-table"],
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("lays out fewer full cards per page than compact cells", async () => {
    const rows = tableRows(6);
    const qr = await makeService(rows);
    const ids = rows.map((r) => r.id);

    const compact = await qr.tableSheetPdf("u1", BUSINESS.id, { ...SHEET, tableIds: ids });
    const cards = await qr.tableSheetPdf("u1", BUSINESS.id, {
      ...SHEET,
      style: "card",
      tableIds: ids,
    });

    expect(pageCount(compact)).toBe(1);
    expect(pageCount(cards)).toBe(2);
  });
});
