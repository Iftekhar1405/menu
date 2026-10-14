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

/**
 * Adds one table from the Tables page, which must already be open.
 *
 * The form is behind "+ Add table" rather than on the page, so every caller
 * needs the same two steps. The confirmation is the per-table select
 * checkbox: on a table's card the name is plain text, and the checkbox is the
 * only node that carries it in an accessible name.
 */
async function addTable(page: Page, label: string) {
  await page.getByRole("button", { name: "+ Add table" }).click();
  await page.getByLabel("Table name / number").fill(label);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel(`Select ${label}`)).toBeAttached();
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
  await addTable(page, "7");
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

  // By role: placing a round also raises a "Round 2 added" toast, which a
  // bare text match collides with.
  await expect(diner.getByRole("heading", { name: "Round 1" })).toBeVisible();
  await expect(diner.getByRole("heading", { name: "Round 2" })).toBeVisible();
  await expect(diner.getByText("₹435")).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/13-diner-order.png`, fullPage: true });

  // ── Staff see it and work it through ─────────────────────────────────────
  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Table 7" })).toBeVisible();

  // The board draws rounds, not one flat list of items. The round heading and
  // the KOT number beside it come from `rounds` on the board's payload and
  // from nowhere else — the flat item list cannot say which ticket a line was
  // printed on — so seeing them here is what proves the payload carries them.
  const roundOne = page.getByRole("region", { name: "Round 1" });
  const roundTwo = page.getByRole("region", { name: "Round 2" });
  await expect(roundOne).toBeVisible();
  await expect(roundTwo.getByText(/KOT #\d+/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/14-orders-board.png`, fullPage: true });

  // Each round is worked on its own. Round one goes all the way to the pass
  // while round two sits untouched, which is the whole point of rounds: a
  // coffee ordered late does not drag a plated dosa back to New.
  await roundOne.getByRole("button", { name: "Accept" }).click();
  await roundOne.getByRole("button", { name: "Start" }).click();
  await roundOne.getByRole("button", { name: "Ready" }).click();
  await expect(roundTwo.getByRole("button", { name: "Accept" })).toBeVisible();

  // The order is only as advanced as its least advanced round, so the diner
  // is not told their food is being made until round two is started too.
  await roundTwo.getByRole("button", { name: "Accept" }).click();
  await roundTwo.getByRole("button", { name: "Start" }).click();
  await expect(diner.getByText("Being made")).toBeVisible({ timeout: 15_000 });

  await roundTwo.getByRole("button", { name: "Ready" }).click();

  // Settling the table is the one whole-order act left on the card: it
  // finishes every round still live on it, and bills them together.
  await page.getByRole("button", { name: "Serve all" }).click();

  // Completing frees the table: the running order view is gone, which is
  // "show only the current order, never previous ones". Since Phase 3 the
  // bill takes its place rather than an empty state.
  await expect(diner.getByRole("heading", { name: "Your bill" })).toBeVisible({
    timeout: 15_000,
  });
  await expect(diner.getByRole("heading", { name: "Round 1" })).toHaveCount(0);
  await expect(diner.getByRole("heading", { name: "Round 2" })).toHaveCount(0);
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
  await addTable(pageA, "1");
  await addTable(pageA, "2");

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
    // Through the web app's own /api/auth proxy, not straight at the API.
    // The refresh cookie is deliberately scoped to Path=/api/auth on this
    // origin so Safari treats it as first-party, which means a direct call to
    // the API's /auth/refresh is sent without it and comes back unauthorised.
    const refresh = await fetch("/api/auth/refresh", {
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

test("the ordering page uses the layout the owner chose", async ({ page, browser }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Layout Owner");
  await page.getByLabel("Email or phone number").fill(`layout${Date.now()}@kumar.test`);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Layout Cafe");
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByPlaceholder("Coffee").fill("Snacks");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a dish to Snacks" }).click();
  await page.getByLabel("Name").fill("Samosa");
  await page.getByPlaceholder("140").first().fill("40");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Samosa/ })).toBeVisible();

  await page.getByRole("link", { name: "Tables" }).click();
  await addTable(page, "1");
  const token = await getTableToken(page);

  // Editorial is the default: one dish per row, not a grid.
  const diner = await (await browser.newContext()).newPage();
  await diner.setViewportSize({ width: 420, height: 900 });
  await diner.goto(`/t/${token}`);
  await expect(diner.getByRole("button", { name: "Add Samosa" })).toBeVisible();
  await expect(diner.locator("ul.grid")).toHaveCount(0);

  // Switch to Grid, and the ordering page must follow.
  await page.getByRole("link", { name: "Appearance" }).click();
  await page.getByRole("button", { name: /Grid/ }).click();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Your menu is updated.")).toBeVisible();

  await diner.reload();
  await expect(diner.locator("ul.grid")).toHaveCount(1);
  await expect(diner.getByRole("button", { name: "Add Samosa" })).toBeVisible();

  // Search comes from the shared layout, so the ordering page gained it too.
  await expect(diner.getByLabel("Search the menu")).toBeVisible();
  await diner.screenshot({ path: `${SHOTS}/22-ordering-grid.png`, fullPage: true });
});

/**
 * Kitchen staff work a real order through cooking. The UI for adding the
 * login itself is covered end to end by kitchen.spec.ts; this test needs a
 * diner's placed order, which is exactly the fixture this file already
 * builds, so the login here is created through the API directly rather than
 * duplicating table-claim setup for a second time.
 *
 * The handover is half the point. A kitchen board starts at Accepted, so the
 * round only becomes theirs once the counter has taken the table on — before
 * that the card is on the owner's board and nowhere else.
 */
test("kitchen staff cook an accepted round to Ready, never see Served or money", async ({
  page,
  context,
}) => {
  await page.goto("/signup");
  const email = `kitchen-board${Date.now()}@kumar.test`;
  await page.getByLabel("Your name").fill("Board Owner");
  await page.getByLabel("Email or phone number").fill(email);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Board Test Kitchen");
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByPlaceholder("Coffee").fill("Snacks");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Add a dish to Snacks" }).click();
  await page.getByLabel("Name").fill("Vada");
  await page.getByPlaceholder("140").first().fill("50");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Vada/ })).toBeVisible();

  await page.getByRole("link", { name: "Tables" }).click();
  await addTable(page, "9");
  const token = await getTableToken(page);

  const staffPhone = `+9198${String(Date.now()).slice(-8)}`;
  const issuedPin = await createKitchenLogin(page, staffPhone);

  // ── Diner places a real order ────────────────────────────────────────────
  const diner = await context.newPage();
  await diner.setViewportSize({ width: 420, height: 900 });
  await diner.goto(`/t/${token}`);
  await expect(diner).toHaveURL(/\/order$/);
  await diner.getByRole("button", { name: "Add Vada" }).click();
  await diner.getByRole("button", { name: "Place order" }).click();
  await expect(diner.getByText("Sent to the kitchen")).toBeVisible();

  // ── Kitchen signs in, in a separate browser context ──────────────────────
  const kitchenContext = await context.browser()!.newContext();
  const kitchen = await kitchenContext.newPage();
  await kitchen.goto("/login");
  await kitchen.getByLabel("Email or phone number").fill(staffPhone);
  await typePin(kitchen, "6-digit PIN", issuedPin);

  // The owner issued this PIN, so the account owes a PIN change before
  // anything else works — same as every kitchen login, API-created or not.
  await expect(kitchen).toHaveURL(/\/change-pin/);
  const ownPin = "445566";
  await typePin(kitchen, "PIN you were given", issuedPin);
  await typePin(kitchen, "New PIN", ownPin);
  await typePin(kitchen, "New PIN again", ownPin);
  await kitchen.getByRole("button", { name: "Save PIN" }).click();
  await expect(kitchen).toHaveURL(/\/login/);

  await kitchen.getByLabel("Email or phone number").fill(staffPhone);
  await typePin(kitchen, "6-digit PIN", ownPin);
  await expect(kitchen).toHaveURL(/\/orders/);

  // No money anywhere on the board.
  await expect(kitchen.getByText(/₹/)).toHaveCount(0);

  // The ticket is not theirs yet. A kitchen board opens at Accepted, so an
  // order whose only round nobody has taken on is on nobody's pass — taking
  // a table on is a counter decision, and a pass crowded with orders the
  // counter has not honoured is noise the kitchen cannot act on.
  await expect(kitchen.getByText("Vada")).toHaveCount(0);

  // The owner takes it on, and only then does it reach the kitchen. Their
  // board polls, so this is the first thing to wait for rather than assert.
  await page.getByRole("link", { name: "Orders" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await expect(kitchen.getByText("Vada")).toBeVisible();

  // Start → Ready. Completing (which bills) and cancelling are an owner's
  // calls, not the kitchen's, so "Served" must never appear.
  await expect(kitchen.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(kitchen.getByRole("button", { name: "Served" })).toHaveCount(0);

  await kitchen.getByRole("button", { name: "Start" }).click();
  await expect(kitchen.getByRole("button", { name: "Ready" })).toBeVisible();
  await expect(kitchen.getByRole("button", { name: "Served" })).toHaveCount(0);

  await kitchen.getByRole("button", { name: "Ready" }).click();
  // Now sitting in the Ready column, where a kitchen login has no further
  // button at all — only an owner can mark it Served.
  await expect(kitchen.getByText("Vada")).toBeVisible();
  await expect(kitchen.getByRole("button", { name: "Served" })).toHaveCount(0);
  await expect(kitchen.getByText(/₹/)).toHaveCount(0);

  await kitchenContext.close();
});

/** Creates a kitchen login through the owner API, returning the issued PIN. */
async function createKitchenLogin(page: Page, identifier: string): Promise<string> {
  return page.evaluate(async (phone) => {
    const api = "http://localhost:4000";
    // Same reason as getTableTokens: the refresh cookie only reaches the
    // same-origin /api/auth proxy, never the API's own /auth path.
    const refresh = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    const { accessToken } = (await refresh.json()) as { accessToken: string };

    const businesses = await fetch(`${api}/businesses/mine`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }).then((r) => r.json() as Promise<{ id: string }[]>);

    const res = await fetch(`${api}/businesses/${businesses[0]!.id}/staff`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Kitchen Tester", identifier: phone, country: "IN" }),
    }).then((r) => r.json() as Promise<{ pin: string }>);

    return res.pin;
  }, identifier);
}

/**
 * The reason rounds exist at all.
 *
 * A table orders a biryani at eight, the kitchen plates it, and at nine the
 * same table adds a chai. Status used to live on the order, so the chai
 * dragged the biryani back to New and the pass cooked it a second time. A
 * round now carries its own status, and the order's is derived as its least
 * advanced round — so the card does move back to New, because something on
 * that table really is unstarted, but the biryani inside it does not.
 *
 * This is the one case worth paying a browser for. Nothing smaller can catch
 * the regression: it needs a real round row with its own status (Postgres and
 * its derive trigger), a board payload that carries every round (the API's
 * `rounds` include), and a card that draws and advances each round on its own
 * (React). A unit test on any one of those three keeps passing while a table
 * loses its dinner.
 */
test("a second round does not drag the first one backwards", async ({ page, context }) => {
  // ── An owner with one table and two dishes ───────────────────────────────
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Rounds Owner");
  await page.getByLabel("Email or phone number").fill(`rounds${Date.now()}@kumar.test`);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Rounds Biryani House");
  await page.getByRole("button", { name: "Restaurant" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByPlaceholder("Coffee").fill("Mains");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  for (const [dish, price] of [
    ["Chicken Biryani", "260"],
    ["Irani Chai", "20"],
  ]) {
    await page.getByRole("button", { name: "Add a dish to Mains" }).click();
    await page.getByLabel("Name").fill(dish!);
    await page.getByPlaceholder("140").first().fill(price!);
    await page.getByRole("button", { name: "Add dish" }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${dish}`) })).toBeVisible();
  }

  await page.getByRole("link", { name: "Tables" }).click();
  await addTable(page, "8");
  const token = await getTableToken(page);

  // ── Eight o'clock: the biryani, cooked all the way to the pass ───────────
  const diner = await context.newPage();
  await diner.setViewportSize({ width: 420, height: 900 });
  await diner.goto(`/t/${token}`);
  await expect(diner).toHaveURL(/\/order$/);
  await diner.getByRole("button", { name: "Add Chicken Biryani" }).click();
  await diner.getByRole("button", { name: "Place order" }).click();
  await expect(diner.getByText("Sent to the kitchen")).toBeVisible();

  await page.getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Table 8" })).toBeVisible();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await page.getByRole("button", { name: "Ready" }).click();

  // A lone round is drawn without a heading or a chip — one card saying
  // "Round 1" on every table would be noise — so the proof it reached the
  // pass is the only move an owner has left on it.
  await expect(page.getByRole("button", { name: "Served" })).toBeVisible();

  // ── Nine o'clock: the same table adds a chai ─────────────────────────────
  await diner.getByRole("button", { name: "Menu" }).click();
  await diner.getByRole("button", { name: "Add Irani Chai" }).click();
  await diner.getByRole("button", { name: "Place order" }).click();
  // By role, not by text: placing a round also raises a "Round 2 added"
  // toast, so a bare text match is ambiguous.
  await expect(diner.getByRole("heading", { name: "Round 2" })).toBeVisible();

  // The card is back in New, because the table's least advanced round is the
  // chai. The biryani is untouched by that: still Ready, still plated.
  await expect(page.getByTestId("round-1-status")).toHaveText("Ready");
  await expect(page.getByTestId("round-2-status")).toHaveText("New");

  // And each round still offers only its own move, so nobody can re-cook the
  // biryani by working the card the chai put in front of them.
  const roundOne = page.getByRole("region", { name: "Round 1" });
  const roundTwo = page.getByRole("region", { name: "Round 2" });
  await expect(roundOne.getByText(/KOT #\d+/)).toBeVisible();
  await expect(roundOne.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(roundTwo.getByRole("button", { name: "Accept" })).toBeVisible();
});
