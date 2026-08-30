import { Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import type { Table } from "@prisma/client";
import { BusinessesService } from "../businesses/businesses.service";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Tokens are 32 hex characters from a CSPRNG — 128 bits. Guessing one is not a
 * practical attack, and the only place it exists is printed on that table's own
 * card, so holding it is equivalent to sitting at the table.
 */
export function generateTableToken(): string {
  return randomBytes(16).toString("hex");
}

@Injectable()
export class TablesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly businesses: BusinessesService,
  ) {}

  async list(userId: string, businessId: string): Promise<Table[]> {
    await this.businesses.assertOwns(userId, businessId);
    return this.prisma.db.table.findMany({
      where: { businessId },
      orderBy: { position: "asc" },
    });
  }

  async create(userId: string, businessId: string, label: string): Promise<Table> {
    await this.businesses.assertOwns(userId, businessId);
    const last = await this.prisma.db.table.findFirst({
      where: { businessId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    return this.prisma.db.table.create({
      data: {
        businessId,
        label: label.trim(),
        token: generateTableToken(),
        position: (last?.position ?? -1) + 1,
      },
    });
  }

  /** Creates several at once — "add tables 1 to 20" is the common first move. */
  async createRange(
    userId: string,
    businessId: string,
    from: number,
    to: number,
    prefix: string,
  ): Promise<number> {
    await this.businesses.assertOwns(userId, businessId);
    const last = await this.prisma.db.table.findFirst({
      where: { businessId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    let position = (last?.position ?? -1) + 1;
    const rows = [];
    for (let n = from; n <= to; n++) {
      rows.push({
        businessId,
        label: `${prefix}${n}`.trim(),
        token: generateTableToken(),
        position: position++,
      });
    }

    const result = await this.prisma.db.table.createMany({ data: rows });
    return result.count;
  }

  async update(
    userId: string,
    businessId: string,
    tableId: string,
    patch: { label?: string; isActive?: boolean },
  ): Promise<Table> {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertBelongs(businessId, tableId);

    // The token is absent from the patch type on purpose: it is printed on a
    // physical card, so it is as immutable as the business public code.
    return this.prisma.db.table.update({
      where: { id: tableId },
      data: {
        ...(patch.label !== undefined && { label: patch.label.trim() }),
        ...(patch.isActive !== undefined && { isActive: patch.isActive }),
      },
    });
  }

  async remove(userId: string, businessId: string, tableId: string): Promise<void> {
    await this.businesses.assertOwns(userId, businessId);
    await this.assertBelongs(businessId, tableId);
    await this.prisma.db.table.delete({ where: { id: tableId } });
  }

  async get(userId: string, businessId: string, tableId: string): Promise<Table> {
    await this.businesses.assertOwns(userId, businessId);
    return this.assertBelongs(businessId, tableId);
  }

  private async assertBelongs(businessId: string, tableId: string): Promise<Table> {
    const table = await this.prisma.db.table.findFirst({
      where: { id: tableId, businessId },
    });
    if (!table) throw new NotFoundException("Table not found");
    return table;
  }
}
