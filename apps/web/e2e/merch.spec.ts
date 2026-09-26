import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 4: owners order printed cards; only we can see those orders.
 *
 * The load-bearing assertion is the negative one — an ordinary owner sees no
 * admin nav entry and is refused the admin page even by typing the URL. That
 * is the whole requirement ("only one seeded owner can see"), so it is tested
 * rather than assumed.
 */

const SHOTS = "e2e/shots";
const PIN = "889900";
const ADMIN_EMAIL = "admin@irad.solutions";
const ADMIN_PIN = "204815";

async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

test("an owner requests printed cards and only the platform admin sees it", async ({
  page,
  browser,
}) => {
  const business = `Card Shop ${Date.now() % 100000}`;

  // ── Owner sets up tables ─────────────────────────────────────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Nisha");
  await page.getByLabel("Email or phone number").fill(`cards${Date.now()}@kumar.test`);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill(business);
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Tables" }).click();
  await page.getByRole("button", { name: "Add several" }).click();
  // `exact`, because getByLabel matches on substring by default and "To"
  // is inside "Open Next.js Dev Tools" — the dev overlay's own button, which
  // is present on every page in development.
  await page.getByLabel("From", { exact: true }).fill("1");
  await page.getByLabel("To", { exact: true }).fill("6");
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByLabel(/Table name, currently 6/)).toBeVisible();

  // ── The owner must not see any admin entry ───────────────────────────────
  await expect(page.getByRole("link", { name: "Card orders" })).toHaveCount(0);

  // ── Order cards ──────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Printed cards" }).click();
  await expect(
    page.getByRole("heading", { name: "Printed QR cards" }),
  ).toBeVisible();
  await expect(page.getByText("PVC table card")).toBeVisible();

  // Below the minimum, the button stays disabled and says why.
  await page.getByRole("button", { name: "1", exact: true }).click();
  await expect(page.getByText("Choose at least 5 tables")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send request" })).toBeDisabled();

  await page.getByRole("button", { name: "Select all" }).click();
  // 6 tables x Rs 90
  await expect(page.getByText("₹540")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send request" })).toBeEnabled();

  await page.getByLabel("Contact name").fill("Nisha R");
  await page.getByLabel("Phone").fill("9876500011");
  await page.getByLabel("Address").fill("4 Church Street");
  await page.getByLabel("City").fill("Bengaluru");
  await page.getByLabel("State").fill("Karnataka");
  await page.getByLabel("PIN code").fill("560001");
  await page.screenshot({ path: `${SHOTS}/19-merch-order.png`, fullPage: true });

  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText(/Request sent/)).toBeVisible();
  await expect(page.getByText("Request received")).toBeVisible();

  // ── Typing the admin URL gets an owner nothing ───────────────────────────
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
  // Scoped to the page body: their own business name legitimately appears in
  // their own sidebar. What must be absent is any admin content.
  await expect(page.locator("main").getByRole("heading", { name: "Card orders" })).toHaveCount(0);
  await expect(page.locator("main").getByText("Ship to")).toHaveCount(0);
  await expect(page.locator("main").getByText("Print artwork", { exact: false })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/20-admin-denied.png`, fullPage: true });

  // ── The platform admin, in a separate browser ────────────────────────────
  const admin = await (await browser.newContext()).newPage();
  await admin.goto("/login");
  await admin.getByLabel("Email or phone number").fill(ADMIN_EMAIL);
  await typePin(admin, "6-digit PIN", ADMIN_PIN);

  await admin.getByRole("link", { name: "Card orders" }).click();
  await expect(admin.getByRole("heading", { name: "Card orders" })).toBeVisible();

  // The admin sees this business's request even though they do not own it.
  await expect(admin.getByRole("heading", { name: business })).toBeVisible();
  // Quantity and name are separate spans, so match the list item rather than
  // a contiguous string.
  // Scoped to this order's card: earlier runs leave other orders on the board.
  const card = admin.getByRole("listitem").filter({ hasText: business });
  await expect(card.getByText("PVC table card")).toBeVisible();
  await expect(card.getByText("6×")).toBeVisible();
  await expect(card.getByText("4 Church Street")).toBeVisible();
  await admin.screenshot({ path: `${SHOTS}/21-admin-orders.png`, fullPage: true });

  // Quote it, and record a note the owner must never see.
  await card.getByLabel("Quoted total").fill("510");
  await card.getByLabel("Internal notes").fill("Offered a bulk discount.");
  await card.getByLabel("Internal notes").blur();
  await card.getByRole("button", { name: "Mark quoted" }).click();
  await expect(card.getByText("Quoted", { exact: true })).toBeVisible();

  // The print file: one page per table.
  const download = admin.waitForEvent("download");
  await card.getByRole("button", { name: /Print artwork · 6 cards/ }).click();
  expect((await download).suggestedFilename()).toContain("artwork.pdf");

  // ── The owner sees the quote but never the internal note ─────────────────
  await page.goto("/merch");
  await expect(page.getByText("Quoted — check your email")).toBeVisible();
  await expect(page.getByText("₹510")).toBeVisible();
  await expect(page.getByText("Offered a bulk discount.")).toHaveCount(0);
});
