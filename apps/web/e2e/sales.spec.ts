import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";

/**
 * Sales records: served → paid with a mode → on the Sales register → in the
 * export → in Insights. And the money rule that payment introduces: once a
 * bill is paid, the diner can no longer take the service charge off it.
 */

const SHOTS = "e2e/shots";
const EMAIL = `sales${Date.now()}@kumar.test`;
const PIN = "551234";

async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

async function getTableToken(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const api = "http://localhost:4000";
    // Same-origin auth proxy: the refresh cookie lives on the web origin.
    const refresh = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
    const { accessToken } = (await refresh.json()) as { accessToken: string };
    const headers = { Authorization: `Bearer ${accessToken}` };
    const [biz] = await fetch(`${api}/businesses/mine`, { headers }).then((r) => r.json() as Promise<{ id: string }[]>);
    const tables = await fetch(`${api}/businesses/${biz!.id}/tables`, { headers }).then(
      (r) => r.json() as Promise<{ token: string }[]>,
    );
    return tables[0]!.token;
  });
}

test("served → paid by UPI → Sales → export → Insights", async ({ page, context }) => {
  // ── Owner: a ₹100 dish, a 5% service charge, one table ───────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Asha");
  await page.getByLabel("Email or phone number").fill(EMAIL);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Asha Tea Stall");
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByPlaceholder("Coffee").fill("Drinks");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a dish to Drinks" }).click();
  await page.getByLabel("Name").fill("Masala tea");
  await page.getByPlaceholder("140").first().fill("100");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Masala tea/ })).toBeVisible();

  await page.getByRole("link", { name: "Billing" }).click();
  await page.getByRole("switch", { name: "Add a service charge" }).click();
  await page.getByLabel("Rate (%)", { exact: true }).fill("5");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.getByRole("link", { name: "Tables" }).click();
  await page.getByRole("button", { name: "+ Add table" }).click();
  await page.getByLabel("Table name / number").fill("E2E 1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("E2E 1").first()).toBeVisible();

  // ── Diner orders ─────────────────────────────────────────────────────────
  const diner = await context.newPage();
  await diner.goto(`/t/${await getTableToken(page)}`);
  await diner.getByRole("button", { name: "Add Masala tea" }).click();
  await diner.getByRole("button", { name: "Place order" }).click();
  await expect(diner.getByText("Sent to the kitchen")).toBeVisible();

  // ── Staff serve it: it moves to To collect with the billed total ─────────
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Table E2E 1" })).toBeVisible();
  // Paying is offered only once the food is out: settling an order from an
  // open column would take it off the kitchen board before it was cooked.
  await expect(page.getByRole("button", { name: "Paid", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: "Ready" }).click();
  await page.getByRole("button", { name: "Served" }).click();

  const collect = page.locator("#segpanel-collect");
  await expect(collect.getByText("Table E2E 1")).toBeVisible({ timeout: 15_000 });
  // ₹100 + 5% service charge.
  await expect(collect.getByText("₹105")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/30-to-collect.png`, fullPage: true });

  await collect.getByRole("button", { name: "Paid", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "UPI", exact: true }).click();
  // Nothing open and nothing to collect: the board collapses to its empty
  // line, and the order is in today's history marked UPI.
  await expect(page.getByText("Nothing cooking right now.")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: /Earlier today/ }).click();
  await expect(page.getByText("UPI", { exact: true })).toBeVisible();

  // ── The diner can still fetch the bill, but cannot change a paid amount ──
  const bill = await diner.request.get("/api/table/bill");
  expect(bill.status()).toBe(200);
  const remove = await diner.request.post("/api/table/bill/service-charge/remove");
  expect(remove.ok()).toBe(false);

  // ── Sales register ───────────────────────────────────────────────────────
  await page.getByRole("link", { name: "Sales" }).click();
  await expect(page.getByRole("heading", { name: "Sales" })).toBeVisible();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(page.getByText("Paid · UPI")).toBeVisible();
  const tile = (label: string) => page.locator("dt", { hasText: new RegExp(`^${label}$`) }).locator("xpath=..");
  await expect(tile("UPI")).toContainText("₹105");
  await expect(tile("Unpaid")).toContainText("₹0");
  await page.screenshot({ path: `${SHOTS}/31-sales.png`, fullPage: true });

  // ── Export: spreadsheets only ────────────────────────────────────────────
  await page.getByRole("button", { name: "Export" }).click();
  await page.getByText("Spreadsheets only").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download ZIP" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^sales_asha-tea-stall_\d{4}-\d{2}-\d{2}_to_\d{4}-\d{2}-\d{2}\.zip$/);
  const files = unzipSync(new Uint8Array(readFileSync((await download.path())!)));
  expect(Object.keys(files).some((f) => f.startsWith("bills/"))).toBe(false);
  expect(strFromU8(files["sales-register.csv"]!)).toContain(",Paid,UPI,");
  expect(strFromU8(files["bill-items.csv"]!)).toContain("Masala tea");
  expect(strFromU8(files["README.txt"]!)).toContain("not GST tax invoices");

  // ── Insights ─────────────────────────────────────────────────────────────
  await page.goto("/insights?p=today");
  const kpi = (label: string) => page.locator("p", { hasText: new RegExp(`^${label}$`) }).locator("xpath=..");
  await expect(kpi("Gross sales")).toContainText("₹105");
  await expect(kpi("Bills")).toContainText("1");
  await page.screenshot({ path: `${SHOTS}/32-insights.png`, fullPage: true });
});
