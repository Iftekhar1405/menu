import { test, expect, type Page } from "@playwright/test";

/**
 * Phase 2: a diner scans their table's card and orders from it.
 *
 * The assertion that matters most here is the negative one — that a second
 * diner cannot reach the first table's order by editing the URL. That
 * requirement is the reason the table lives in a cookie rather than the
 * address, so it gets tested rather than assumed.
 */

const SHOTS = "e2e/shots";
const stamp = Date.now();
const EMAIL = `service${stamp}@kumar.test`;
const PIN = "551234";

async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

test("a diner orders from a table and staff work it through", async ({ page, context }) => {
  // ── Owner sets up a menu and a table ─────────────────────────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Ravi K");
  await page.getByLabel("Email or phone number").fill(EMAIL);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Ravi Dosa Corner");
  await page.getByRole("button", { name: "Restaurant" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByPlaceholder("Coffee").fill("Dosa");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await page.getByRole("button", { name: "Add a dish to Dosa" }).click();
  await page.getByLabel("Name").fill("Masala dosa");
  await page.getByPlaceholder("140").first().fill("140");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Masala dosa/ })).toBeVisible();

  await page.getByRole("button", { name: "Add a dish to Dosa" }).click();
  await page.getByLabel("Name").fill("Filter coffee");
  await page.getByRole("button", { name: "Add sizes" }).click();
  await page.locator('input[placeholder="Small"]').nth(0).fill("Single");
  await page.locator('input[placeholder="140"]').nth(0).fill("60");
  await page.locator('input[placeholder="Small"]').nth(1).fill("Double");
  await page.locator('input[placeholder="140"]').nth(1).fill("95");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Filter coffee/ })).toBeVisible();

  await page.getByRole("link", { name: "Tables" }).click();
  await page.getByLabel("Add a table").fill("7");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel(/Table name, currently 7/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/10-tables.png`, fullPage: true });

  // ── Diner scans the card ─────────────────────────────────────────────────
  const diner = await context.newPage();
  await diner.setViewportSize({ width: 420, height: 900 });

  // With no session at all, /order must offer the scanner — not an error.
  const stranger = await (await diner.context().browser()!.newContext()).newPage();
  await stranger.goto("/order");
  await expect(
    stranger.getByRole("heading", { name: "Scan the code on your table" }),
  ).toBeVisible();
  await stranger.screenshot({ path: `${SHOTS}/11-scanner.png`, fullPage: true });
  await stranger.close();

  const tableToken = await getTableToken(page);
  await diner.goto(`/t/${tableToken}`);

  // The crux: after the redirect the address must be exactly /order, with no
  // table anywhere in it.
  await expect(diner).toHaveURL(/\/order$/);
  await expect(diner.getByText("Table 7")).toBeVisible();
  await expect(diner.getByRole("heading", { name: "Ravi Dosa Corner" })).toBeVisible();

  // ── Round one ────────────────────────────────────────────────────────────
  await diner.getByRole("button", { name: "Add Masala dosa" }).click();
  await diner.getByRole("button", { name: "Add Masala dosa" }).click();
  await diner.getByRole("button", { name: "Add Filter coffee, Double" }).click();
  await expect(diner.getByText("3 items", { exact: false })).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/12-ordering.png`, fullPage: true });

  await diner.getByRole("button", { name: "Place order" }).click();
  await expect(diner.getByText("Sent to the kitchen")).toBeVisible();
  // 140 x 2 + 95
  await expect(diner.getByText("₹375")).toBeVisible();

  // ── Round two appends to the same order ──────────────────────────────────
  await diner.getByRole("button", { name: "Menu" }).click();
  await diner.getByRole("button", { name: "Add Filter coffee, Single" }).click();
  await diner.getByRole("button", { name: "Place order" }).click();

  await expect(diner.getByText("Round 1")).toBeVisible();
  await expect(diner.getByText("Round 2")).toBeVisible();
  await expect(diner.getByText("₹435")).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/13-diner-order.png`, fullPage: true });

  // ── Staff see it and work it through ─────────────────────────────────────
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Table 7" })).toBeVisible();
  await expect(page.getByText("Round 2")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/14-orders-board.png`, fullPage: true });

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: "Ready" })).toBeVisible();

  // The diner sees the status change without touching anything.
  await expect(diner.getByText("Being made")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Ready" }).click();
  await page.getByRole("button", { name: "Served" }).click();

  // Completing frees the table: the running order view is gone, which is
  // "show only the current order, never previous ones". Since Phase 3 the
  // bill takes its place rather than an empty state.
  await expect(diner.getByRole("heading", { name: "Your bill" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(diner.getByText("Round 1")).toHaveCount(0);
  await expect(diner.getByText("Round 2")).toHaveCount(0);
});

test("a diner cannot reach another table's order by editing the URL", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();

  // Owner with two tables.
  await pageA.goto("/signup");
  const email = `two${Date.now()}@kumar.test`;
  await pageA.getByLabel("Your name").fill("Owner");
  await pageA.getByLabel("Email or phone number").fill(email);
  await typePin(pageA, "Choose a 6-digit PIN", PIN);
  await pageA.getByLabel("Business name").fill("Two Table Cafe");
  await pageA.getByRole("button", { name: "Cafe" }).click();
  await pageA.getByRole("button", { name: "Create account" }).click();
  await expect(pageA.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await pageA.getByRole("link", { name: "Tables" }).click();
  await pageA.getByLabel("Add a table").fill("1");
  await pageA.getByRole("button", { name: "Add", exact: true }).click();
  await expect(pageA.getByLabel(/Table name, currently 1/)).toBeVisible();
  await pageA.getByLabel("Add a table").fill("2");
  await pageA.getByRole("button", { name: "Add", exact: true }).click();
  await expect(pageA.getByLabel(/Table name, currently 2/)).toBeVisible();

  const [token1, token2] = await getTableTokens(pageA);

  // Diner at table 1.
  const diner1 = await (await browser.newContext()).newPage();
  await diner1.goto(`/t/${token1}`);
  await expect(diner1.getByText("Table 1")).toBeVisible();

  // Diner at table 2, in a separate browser context.
  const diner2 = await (await browser.newContext()).newPage();
  await diner2.goto(`/t/${token2}`);
  await expect(diner2.getByText("Table 2")).toBeVisible();

  // Diner 2 tries every URL shape that might name another table. All of them
  // must keep showing table 2, because the table is not in the URL at all.
  for (const url of ["/order?table=1", "/order?tableId=1", "/order#table=1", "/order"]) {
    await diner2.goto(url);
    await expect(diner2.getByText("Table 2")).toBeVisible();
    await expect(diner2.getByText("Table 1")).toHaveCount(0);
  }

  await contextA.close();
});

/** Reads table tokens through the owner API, as a printed card would carry them. */
async function getTableToken(page: Page): Promise<string> {
  return (await getTableTokens(page))[0]!;
}

async function getTableTokens(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = "http://localhost:4000";
    const refresh = await fetch(`${api}/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    const { accessToken } = (await refresh.json()) as { accessToken: string };

    const businesses = await fetch(`${api}/businesses/mine`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json() as Promise<{ id: string }[]>);

    const tables = await fetch(`${api}/businesses/${businesses[0]!.id}/tables`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json() as Promise<{ token: string }[]>);

    return tables.map((t) => t.token);
  });
}
