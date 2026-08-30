import "../src/config/load-dotenv";
import { PrismaClient } from "@prisma/client";
import { hash } from "@node-rs/argon2";

/**
 * Idempotent seed: the platform admin, and the merchandise catalogue.
 *
 * This runs on every deploy, so running it twice must not create a second
 * admin or duplicate the catalogue. Everything below is an upsert keyed on
 * something stable.
 *
 * Migrations run as the owner role, so this uses DATABASE_URL rather than
 * APP_DATABASE_URL — the seed legitimately needs to write rows that no
 * particular user owns.
 */
const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const ARGON = { memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

const PRODUCTS = [
  {
    sku: "PVC-TABLE-CARD",
    name: "PVC table card",
    blurb:
      "Rigid PVC, 85 × 55mm, matt laminated both sides. Wipes clean, survives a service. One card per table.",
    unitPrice: 90,
    minQuantity: 5,
    leadTimeDays: 7,
    perTable: true,
    position: 0,
  },
  {
    sku: "EPOXY-QR-TAG",
    name: "Epoxy-domed QR tag",
    blurb:
      "Adhesive tag under a clear epoxy dome. Sticks to a table edge or counter and does not scuff. One tag per table.",
    unitPrice: 130,
    minQuantity: 5,
    leadTimeDays: 10,
    perTable: true,
    position: 1,
  },
  {
    sku: "ACRYLIC-STAND",
    name: "Acrylic table stand",
    blurb:
      "Free-standing A6 acrylic block, printed both sides. The most visible option, and the hardest to knock over.",
    unitPrice: 260,
    minQuantity: 2,
    leadTimeDays: 12,
    perTable: true,
    position: 2,
  },
  {
    sku: "WINDOW-DECAL",
    name: "Window decal",
    blurb:
      "150mm static-cling decal carrying your venue menu code, for the door or window. Not per-table.",
    unitPrice: 180,
    minQuantity: 1,
    leadTimeDays: 7,
    perTable: false,
    position: 3,
  },
];

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL ?? "admin@irad.solutions";
  const pin = process.env.SEED_ADMIN_PIN ?? "204815";
  const name = process.env.SEED_ADMIN_NAME ?? "Platform Admin";

  if (!/^\d{6}$/.test(pin)) {
    throw new Error("SEED_ADMIN_PIN must be exactly 6 digits");
  }

  // Keyed on email so re-running promotes the existing account rather than
  // creating a second admin.
  const admin = await prisma.user.upsert({
    where: { email },
    update: { role: "platform_admin", verifiedAt: new Date() },
    create: {
      email,
      pinHash: await hash(pin, ARGON),
      fullName: name,
      role: "platform_admin",
      verifiedAt: new Date(),
    },
  });

  for (const product of PRODUCTS) {
    await prisma.merchProduct.upsert({
      where: { sku: product.sku },
      update: {
        name: product.name,
        blurb: product.blurb,
        unitPrice: product.unitPrice,
        minQuantity: product.minQuantity,
        leadTimeDays: product.leadTimeDays,
        perTable: product.perTable,
        position: product.position,
      },
      create: product,
    });
  }

  console.log(`Platform admin ready: ${admin.email}`);
  console.log(`Catalogue: ${PRODUCTS.length} products`);
  if (pin === "204815") {
    console.warn(
      "WARNING: the admin PIN is still the example value. Change SEED_ADMIN_PIN before deploying.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
