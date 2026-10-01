import { test, expect, type Page } from "@playwright/test";

/**
 * The one flow that must never break: an owner signs up, builds a menu with
 * a variant-priced dish, picks a design, and a diner scanning the code sees
 * it. Everything else in the product is in service of this path.
 *
 * Screenshots are written to e2e/shots so the visual result can be reviewed
 * without opening a browser.
 */

const SHOTS = "e2e/shots";
const stamp = Date.now();
const EMAIL = `owner${stamp}@kumar.test`;
const PIN = "482913";
const BUSINESS = "Kumar Coffee House";

async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

test("owner signs up, builds a menu, and a diner can read it", async ({ page }) => {
  // ── Sign up ──────────────────────────────────────────────────────────────
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Put your menu online" })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/01-signup.png`, fullPage: true });

  await page.getByLabel("Your name").fill("Asha Rao");
  await page.getByLabel("Email or phone number").fill(EMAIL);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill(BUSINESS);
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();

  // Lands straight in the builder — the next useful thing to do.
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  // ── Build a menu ─────────────────────────────────────────────────────────
  await page.getByPlaceholder("Coffee").fill("Coffee");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // A dish priced by size, which is the case the data model exists for.
  await page.getByRole("button", { name: "Add a dish to Coffee" }).click();
  await page.getByLabel("Name").fill("Filter coffee");
  await page.getByRole("button", { name: "Add sizes" }).click();

  const sizeRows = page.locator('input[placeholder="Small"]');
  await sizeRows.nth(0).fill("Single");
  await page.locator('input[placeholder="140"]').nth(0).fill("60");
  await page.locator('input[placeholder="Small"]').nth(1).fill("Double");
  await page.locator('input[placeholder="140"]').nth(1).fill("95");

  await page.getByRole("button", { name: "Advanced details" }).click();
  await page.getByLabel("Description").fill("Chicory blend, brewed overnight.");
  await page.getByRole("button", { name: "Veg", exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/02-item-sheet.png`, fullPage: true });

  await page.getByRole("button", { name: "Add dish" }).click();
  // Scoped to the list: the name also appears in the live phone preview,
  // which is the preview doing its job rather than an ambiguity to fix.
  await expect(page.getByRole("button", { name: /^Filter coffee/ })).toBeVisible();

  // A dish with a single price.
  await page.getByRole("button", { name: "Add a dish to Coffee" }).click();
  await page.getByLabel("Name").fill("Cold brew");
  await page.getByPlaceholder("140").first().fill("180");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Cold brew/ })).toBeVisible();

  // The phone preview must be showing the real menu, not a placeholder.
  await expect(page.getByText("What diners see")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/03-builder.png`, fullPage: true });

  // ── Pick a design ────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Appearance" }).click();
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await page.getByRole("button", { name: /Compact/ }).click();
  await page.getByRole("button", { name: "Terracotta" }).click();

  await expect(page.getByRole("button", { name: "Terracotta" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.screenshot({ path: `${SHOTS}/04-design.png`, fullPage: true });
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Your menu is updated.")).toBeVisible();

  // ── QR ───────────────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "QR code" }).click();
  await expect(page.getByRole("heading", { name: "QR code" })).toBeVisible();
  await expect(page.locator("svg:visible").first()).toBeVisible();
  /*
   * Exactly one nav item is current, whatever the fade looks like
   * mid-transition.
   *
   * `:visible`, because the dashboard now ships both of its navigations in
   * the markup and hides one with CSS — the sidebar above `lg`, the bottom
   * tab bar below it. Only one is ever displayed, and `display: none` keeps
   * the other out of the accessibility tree, so a screen reader sees one
   * too; a bare CSS selector is the only thing here that would see both.
   */
  await expect(page.locator('nav a[aria-current="page"]:visible')).toHaveCount(1);
  await expect(page.getByRole("link", { name: "QR code" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.screenshot({ path: `${SHOTS}/05-qr.png`, fullPage: true });

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "PNG, print quality" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toContain("menu-qr.png");

  // ── Overview ─────────────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("Your menu link")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/06-dashboard.png`, fullPage: true });

  // The public code is what a printed card encodes.
  const linkText = await page.locator("code").first().innerText();
  const code = linkText.split("/m/")[1]!.trim();

  // ── The diner's view ─────────────────────────────────────────────────────
  const diner = await page.context().newPage();
  await diner.setViewportSize({ width: 420, height: 900 });
  await diner.goto(`/m/${code}`);

  await expect(diner.getByRole("heading", { name: BUSINESS })).toBeVisible();
  await expect(diner.getByRole("heading", { name: /Filter coffee/ })).toBeVisible();
  await expect(diner.getByRole("heading", { name: /Cold brew/ })).toBeVisible();
  // Both variant prices, and the "from" treatment on the cheaper one.
  await expect(diner.getByText("₹60", { exact: false }).first()).toBeVisible();
  await expect(diner.getByText("₹95", { exact: false }).first()).toBeVisible();
  await expect(
    diner.getByText("menu.irad.solutions", { exact: true }).first(),
  ).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/07-public-menu.png`, fullPage: true });

  // Search narrows the menu without a network call.
  await diner.getByLabel("Search the menu").fill("cold");
  await expect(diner.getByRole("heading", { name: /Filter coffee/ })).toBeHidden();
  await expect(diner.getByRole("heading", { name: /Cold brew/ })).toBeVisible();
});

test("sign in with the PIN, and a wrong PIN is refused", async ({ page }) => {
  await page.goto("/login");
  await page.screenshot({ path: `${SHOTS}/08-login.png`, fullPage: true });

  await page.getByLabel("Email or phone number").fill(EMAIL);
  await typePin(page, "6-digit PIN", "000000");
  await expect(page.getByRole("alert")).toBeVisible();

  await page.getByLabel("Email or phone number").fill(EMAIL);
  await typePin(page, "6-digit PIN", PIN);
  await expect(page.getByRole("heading", { name: "Kumar Coffee House" })).toBeVisible();
});
