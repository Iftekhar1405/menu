import { expect, test, type Page } from "@playwright/test";

/**
 * An owner creates a kitchen login, and that login can only work a service:
 * see orders and dishes, move an order through cooking, and nothing else —
 * no prices, no bills, no settings, no other section of the dashboard.
 *
 * Runs the staff member in a separate browser context throughout, so signing
 * them in never clobbers the owner's own session cookie.
 */

const SHOTS = "e2e/shots";
const STAMP = Date.now();
const OWNER_EMAIL = `kitchen-owner-${STAMP}@example.test`;
const OWNER_PIN = "482913";
const STAFF_PHONE = `+9198${String(STAMP).slice(-8)}`;
const STAFF_NEW_PIN = "778899";

/** PIN inputs are six boxes, each with its own label. */
async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

test("an owner creates a kitchen login and it can only work a service", async ({
  page,
  context,
}) => {
  // ── Owner signs up ───────────────────────────────────────────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Asha Rao");
  await page.getByLabel("Email or phone number").fill(OWNER_EMAIL);
  await typePin(page, "Choose a 6-digit PIN", OWNER_PIN);
  await page.getByLabel("Business name").fill("Kitchen Test Cafe");
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  // One dish, so /dishes has something to toggle.
  await page.getByPlaceholder("Coffee").fill("Mains");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a dish to Mains" }).click();
  await page.getByLabel("Name").fill("Dosa");
  await page.getByPlaceholder("140").first().fill("120");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Dosa/ })).toBeVisible();

  // ── Owner creates the kitchen login ──────────────────────────────────────
  await page.goto("/settings/staff");
  await page.getByLabel("Name").fill("Ramesh");
  await page.getByLabel("Email or phone number").fill(STAFF_PHONE);
  await page.getByRole("button", { name: "Add kitchen login" }).click();

  const pin = (await page.getByText(/^\d{6}$/).first().textContent())!.trim();
  expect(pin).toMatch(/^\d{6}$/);

  // ── Staff signs in, in a separate browser context ────────────────────────
  const staffContext = await context.browser()!.newContext();
  const kitchen = await staffContext.newPage();
  await kitchen.goto("/login");
  await kitchen.getByLabel("Email or phone number").fill(STAFF_PHONE);
  await typePin(kitchen, "6-digit PIN", pin);

  // Forced PIN change, then back to login because the change revokes
  // sessions — this one included.
  await expect(kitchen).toHaveURL(/\/change-pin/);
  await typePin(kitchen, "PIN you were given", pin);
  await typePin(kitchen, "New PIN", STAFF_NEW_PIN);
  await typePin(kitchen, "New PIN again", STAFF_NEW_PIN);
  await kitchen.getByRole("button", { name: "Save PIN" }).click();

  await expect(kitchen).toHaveURL(/\/login/);
  await kitchen.getByLabel("Email or phone number").fill(STAFF_PHONE);
  await typePin(kitchen, "6-digit PIN", STAFF_NEW_PIN);
  await expect(kitchen.getByRole("link", { name: "Orders" })).toBeVisible();
  await kitchen.screenshot({ path: `${SHOTS}/30-kitchen-board.png`, fullPage: true });

  // ── What they can and cannot see ─────────────────────────────────────────
  await expect(kitchen.getByRole("link", { name: "Orders" })).toBeVisible();
  await expect(kitchen.getByRole("link", { name: "Dishes" })).toBeVisible();
  for (const hidden of [
    "Billing",
    "Settings",
    "QR code",
    "Printed cards",
    "Overview",
    "Tables",
  ]) {
    await expect(kitchen.getByRole("link", { name: hidden, exact: true })).toHaveCount(0);
  }

  await kitchen.goto("/billing");
  await expect(kitchen).toHaveURL(/\/orders/);

  await kitchen.goto("/dishes");
  await expect(kitchen.getByText("Dosa")).toBeVisible();
  await expect(kitchen.getByText(/₹/)).toHaveCount(0);

  const dishSwitch = kitchen.getByRole("switch", { name: "Dosa" });
  await expect(dishSwitch).toHaveAttribute("aria-checked", "true");
  await dishSwitch.click();
  await expect(dishSwitch).toHaveAttribute("aria-checked", "false");
  await kitchen.screenshot({ path: `${SHOTS}/31-kitchen-dishes.png`, fullPage: true });

  await staffContext.close();
});
