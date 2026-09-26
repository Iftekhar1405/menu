import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 3: staff close an order, the diner gets a bill and is asked how it went.
 *
 * Two assertions here are about policy rather than mechanics, and both are
 * things that are easy to quietly regress: that a diner can remove the service
 * charge from their own bill, and that the Google route is offered at a low
 * rating as well as a high one.
 */

const SHOTS = "e2e/shots";
const PIN = "667788";

async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

async function tableToken(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = "http://localhost:4000";
    const { accessToken } = await fetch(`${api}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    }).then((r) => r.json() as Promise<{ accessToken: string }>);

    const businesses = await fetch(`${api}/businesses/mine`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json() as Promise<{ id: string }[]>);

    const tables = await fetch(`${api}/businesses/${businesses[0]!.id}/tables`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json() as Promise<{ token: string }[]>);

    return tables[0]!.token;
  });
}

test("a diner is billed, can decline the service charge, and can rate the meal", async ({
  page,
  browser,
}) => {
  // ── Owner sets up with tax and a service charge ──────────────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Meera");
  await page.getByLabel("Email or phone number").fill(`bill${Date.now()}@kumar.test`);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Meera Tiffin Room");
  await page.getByRole("button", { name: "Restaurant" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  // A ₹105 dish, tax-inclusive at 5% — bills as ₹100 net plus ₹5 tax.
  await page.getByPlaceholder("Coffee").fill("Tiffin");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a dish to Tiffin" }).click();
  await page.getByLabel("Name").fill("Idli plate");
  await page.getByPlaceholder("140").first().fill("105");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Idli plate/ })).toBeVisible();

  await page.getByRole("link", { name: "Billing" }).click();
  await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();

  // The warning about this not being a tax invoice must be on the page where
  // someone configures tax, not buried in docs.
  await expect(page.getByText("This is a receipt, not a tax invoice")).toBeVisible();

  await page.getByRole("switch", { name: "Show tax on bills" }).click();
  await expect(page.getByLabel("Default rate (%)")).toHaveValue("5");
  await expect(
    page.getByRole("switch", { name: "Menu prices already include tax" }),
  ).toHaveAttribute("aria-checked", "true");

  // The CCPA notice must be visible before an owner switches this on.
  await expect(page.getByText(/2022 CCPA guidelines/)).toBeVisible();
  await page.getByRole("switch", { name: "Add a service charge" }).click();
  await page.getByLabel("Rate (%)", { exact: true }).fill("10");
  await page.screenshot({ path: `${SHOTS}/15-billing-settings.png`, fullPage: true });
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByRole("link", { name: "Tables" }).click();
  await page.getByLabel("Add a table").fill("3");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel(/Table name, currently 3/)).toBeVisible();

  // ── Diner orders ─────────────────────────────────────────────────────────
  const diner = await (await browser.newContext()).newPage();
  await diner.setViewportSize({ width: 420, height: 900 });
  await diner.goto(`/t/${await tableToken(page)}`);
  await expect(diner.getByText("Table 3")).toBeVisible();

  await diner.getByRole("button", { name: "Add Idli plate" }).click();
  await diner.getByRole("button", { name: "Add Idli plate" }).click();
  await diner.getByRole("button", { name: "Place order" }).click();
  await expect(diner.getByText("Sent to the kitchen")).toBeVisible();

  // ── Staff serve it, which bills it ───────────────────────────────────────
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Table 3" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: "Ready" }).click();
  await page.getByRole("button", { name: "Served" }).click();

  // ── The bill ─────────────────────────────────────────────────────────────
  await expect(diner.getByRole("heading", { name: "Your bill" })).toBeVisible({
    timeout: 15_000,
  });

  // 2 x 105 = 210 gross. Inclusive at 5%: net 200, tax 10.
  // Service charge 10% of net = 20, plus 5% tax on that = 1. Total 231.
  await expect(diner.getByText("₹200")).toBeVisible();
  await expect(diner.getByText("₹231")).toBeVisible();
  // Both documents are the diner's to take, not just one.
  await expect(diner.getByRole("button", { name: "Download bill" })).toBeVisible();
  await expect(diner.getByRole("button", { name: "Receipt" })).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/16-diner-bill.png`, fullPage: true });

  // The diner declines the service charge, as they are entitled to.
  await diner
    .getByRole("button", { name: /Service charge is optional/ })
    .click();
  // The span beside the "Total" label, not the first ₹210 on the page: the
  // same figure is also the line total for 2 × ₹105 and the pre-tax subtotal
  // once the service charge comes off, so a bare text match is ambiguous and
  // would pass on the wrong one.
  await expect(
    diner.getByText("Total", { exact: true }).locator("xpath=following-sibling::span"),
  ).toHaveText("₹210");
  await expect(diner.getByText(/Service charge \(/)).toHaveCount(0);

  // ── Rating ───────────────────────────────────────────────────────────────
  await expect(diner.getByRole("heading", { name: "How was it?" })).toBeVisible();

  // Two stars: the low band must still be offered wording and a route out.
  // Withholding those from unhappy diners is review gating.
  await diner.getByRole("button", { name: "2 stars" }).click();
  await expect(
    diner.getByText("Service was slow and the order took a while to arrive."),
  ).toBeVisible();
  await expect(
    diner.getByText(/Anything just for Meera Tiffin Room/),
  ).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/17-rating.png`, fullPage: true });

  await diner
    .getByPlaceholder("Goes straight to the owner.")
    .fill("Idli was cold when it arrived.");
  await diner.getByRole("button", { name: "Send rating" }).click();
  await expect(diner.getByRole("heading", { name: "Thanks for that" })).toBeVisible();

  // ── The owner sees it ────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("What diners said")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Idli was cold when it arrived.")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/18-owner-ratings.png`, fullPage: true });

  // ── A served order stays reachable ───────────────────────────────────────
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("button", { name: /Earlier today/ })).toBeVisible();
  await page.getByRole("button", { name: /Earlier today/ }).click();

  const served = page.getByRole("listitem").filter({ hasText: "Table 3" });
  await expect(served).toBeVisible();

  for (const doc of ["Bill", "Receipt"] as const) {
    const download = page.waitForEvent("download");
    await served.getByRole("button", { name: doc }).click();
    const file = await download;
    expect(file.suggestedFilename()).toContain(doc.toLowerCase());
  }
  await page.screenshot({ path: `${SHOTS}/23-served-today.png`, fullPage: true });
});
