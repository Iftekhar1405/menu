import { test, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * The dashboard on a phone.
 *
 * Runs only under the `mobile` project (iPhone 13, 390×844). Everything
 * asserted here is something that is *only* wrong at that width — page-level
 * horizontal overflow, a field that zooms the viewport when it takes focus, a
 * control smaller than a fingertip, content hidden behind the tab bar.
 * Anything that would fail on a desktop too belongs in the other specs.
 *
 * Serial, against one signed-in page, because the interesting assertions need
 * an account with a menu, a table and a live order behind them. Building that
 * once and reusing it is the difference between a thirty-second spec and a
 * four-minute one.
 */

const SHOTS = "e2e/shots/mobile";
const stamp = Date.now();
const PIN = "624180";

/** Apple's minimum comfortable target. Anything smaller is a mis-tap. */
const MIN_TARGET = 44;

/** Below this, iOS Safari zooms the page when a field takes focus. */
const MIN_FIELD_FONT = 16;

const ROUTES = [
  "/dashboard",
  "/orders",
  "/menu",
  "/tables",
  "/billing",
  "/templates",
  "/qr",
  "/merch",
  "/settings",
];

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;

// The seed does a dozen writes, and against a hosted database each costs
// several seconds. This is a ceiling, not a wait.
test.setTimeout(240_000);

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });
  page = await context.newPage();
  await signUp(page);
  await seedOrder(page, context);
});

test.afterAll(async () => {
  await context?.close();
});

async function typePin(p: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await p.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

/**
 * Retried, with a fresh identifier each time.
 *
 * Signing up is a single write and, against a hosted database, roughly one in
 * six of them comes back 500. That is the database's problem rather than the
 * dashboard's, but it would otherwise fail this whole file before a single
 * assertion about layout had run. A new identifier per attempt, because a
 * request that failed halfway may already have taken the old one.
 */
async function signUp(p: Page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await p.goto("/signup");
    await p.getByLabel("Your name").fill("Asha Rao");
    await p.getByLabel("Email or phone number").fill(`phone${stamp}-${attempt}@kumar.test`);
    await typePin(p, "Choose a 6-digit PIN", PIN);
    await p.getByLabel("Business name").fill("Kumar Coffee House");
    await p.getByRole("button", { name: "Cafe" }).click();
    await p.getByRole("button", { name: "Create account" }).click();

    try {
      await expect(p.getByRole("heading", { name: "Menu", exact: true })).toBeVisible({
        timeout: 20_000,
      });
      return;
    } catch {
      if (attempt === 4) {
        const said = await p.getByRole("alert").first().textContent().catch(() => null);
        throw new Error(`could not sign up after 4 attempts; last said: ${said ?? "nothing"}`);
      }
    }
  }
}

/**
 * A menu, a table, and one order sitting on the board — the state the
 * dashboard is actually used in. Several of the assertions below are vacuous
 * against an empty account: an Orders page with nothing on it renders an
 * empty state and no board at all.
 */
/**
 * Retries an action whose only failure mode here is the network.
 *
 * Several of the dashboard's form handlers do not surface a failed write —
 * the field keeps its text and nothing else happens — so against a remote
 * database a dropped request looks exactly like a button that did nothing.
 * Tapping again is what a person would do.
 */
async function insist(
  act: () => Promise<void>,
  settled: () => Promise<unknown>,
  what: string,
) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await act();
    try {
      await settled();
      return;
    } catch {
      if (attempt === 3) throw new Error(`${what} did not take after 3 attempts`);
    }
  }
}

async function seedOrder(p: Page, ctx: BrowserContext) {
  await insist(
    async () => {
      await p.getByPlaceholder("Coffee").fill("Dosa");
      await p.getByRole("button", { name: "Add", exact: true }).click();
    },
    () =>
      expect(p.getByRole("button", { name: "Add a dish to Dosa" })).toBeVisible({
        timeout: 15_000,
      }),
    "adding the Dosa section",
  );

  await p.getByRole("button", { name: "Add a dish to Dosa" }).click();
  await p.getByLabel("Name").fill("Masala dosa");
  await p.getByPlaceholder("140").first().fill("140");
  await p.getByRole("button", { name: "Add dish" }).click();
  await expect(p.getByRole("button", { name: /^Masala dosa/ })).toBeVisible();

  await p.getByRole("link", { name: "Tables" }).click();
  await insist(
    async () => {
      await p.getByLabel("Add a table").fill("7");
      await p.getByRole("button", { name: "Add", exact: true }).click();
    },
    () =>
      expect(p.getByLabel(/Table name, currently 7/)).toBeVisible({ timeout: 15_000 }),
    "adding table 7",
  );

  const token = await p.evaluate(async () => {
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

  const diner = await ctx.browser()!.newContext();
  const dinerPage = await diner.newPage();
  await dinerPage.goto(`/t/${token}`);
  await dinerPage.getByRole("button", { name: "Add Masala dosa" }).click();
  await dinerPage.getByRole("button", { name: "Place order" }).click();
  await expect(dinerPage.getByText("Sent to the kitchen")).toBeVisible();
  await diner.close();

  // Leave the owner's page somewhere settled, so the first test's goto is not
  // racing a navigation this function started.
  await gotoSettled(p, "/dashboard");
  await expect(p.getByRole("navigation", { name: "Sections" })).toBeVisible();
}

/**
 * The whole document, not a nominated element. A single over-wide child
 * anywhere on the page pushes the body, and that is exactly the failure this
 * is looking for. One pixel of slack absorbs sub-pixel layout rounding.
 */
async function expectNoSideScroll(p: Page, where: string) {
  const overflow = await p.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow, `${where} scrolls sideways by ${overflow}px`).toBeLessThanOrEqual(1);
}

function tabBar() {
  return page.getByRole("navigation", { name: "Sections" });
}

/**
 * A client-side navigation left in flight by the previous step aborts a goto
 * issued on top of it. That is the harness racing itself rather than the page
 * misbehaving, so it is retried instead of reported.
 */
async function gotoSettled(p: Page, route: string) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await p.goto(route, { waitUntil: "domcontentloaded" });
      return;
    } catch (err) {
      if (attempt === 3 || !/interrupted by another navigation/.test(String(err))) {
        throw err;
      }
    }
  }
}

async function visit(route: string) {
  await gotoSettled(page, route);
  await settleShell();
  await expect(tabBar()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${route}$`));
}

/**
 * Takes the dashboard's own offer when a load fails.
 *
 * Against a hosted database a request fails outright often enough to hit this
 * during a run. The shell answers that with "Try again" rather than by
 * signing the owner out, so tapping it is both the way past the blip and a
 * check that the offer works.
 */
async function settleShell() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const retry = page.getByRole("button", { name: "Try again" });
    if (!(await retry.isVisible().catch(() => false))) return;
    await retry.click();
    await expect(retry).toBeHidden({ timeout: 20_000 }).catch(() => undefined);
  }
}

test("no page scrolls sideways", async () => {
  for (const route of ROUTES) {
    await visit(route);
    await expectNoSideScroll(page, route);
  }
});

test("the tab bar is reachable and More holds the rest", async () => {
  await visit("/dashboard");

  for (const name of ["Overview", "Orders", "Menu", "Tables"]) {
    const tab = tabBar().getByRole("link", { name });
    await expect(tab).toBeVisible();
    const box = await tab.boundingBox();
    expect(box, `${name} tab has no box`).not.toBeNull();
    expect(box!.height, `${name} tab is ${box!.height}px tall`).toBeGreaterThanOrEqual(
      MIN_TARGET,
    );
  }

  // The sections that don't fit the bar live one tap away.
  await tabBar().getByRole("button", { name: "More" }).click();
  const sheet = page.getByRole("dialog", { name: "More sections" });
  await expect(sheet.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Printed cards" })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Sign out" })).toBeVisible();

  await sheet.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
});

test("the tab bar never covers the end of a page", async () => {
  await visit("/settings");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));

  const clear = await page.evaluate(() => {
    const main = document.querySelector("main");
    const bar = document.querySelector('[data-testid="tab-bar"]');
    const last = main?.lastElementChild?.getBoundingClientRect();
    if (!bar || !last) return null;
    return bar.getBoundingClientRect().top - last.bottom;
  });

  expect(clear, "no tab bar or no content to measure").not.toBeNull();
  expect(clear!, "the last of the page sits under the tab bar").toBeGreaterThanOrEqual(0);
});

test("no field is small enough to zoom the viewport", async () => {
  for (const route of ["/tables", "/merch", "/settings", "/billing"]) {
    await visit(route);

    const tooSmall = await page.evaluate((min) => {
      const bad: string[] = [];
      for (const field of document.querySelectorAll("input, select, textarea")) {
        const el = field as HTMLInputElement;
        if (el.type === "checkbox" || el.type === "radio" || el.type === "file") continue;
        const size = parseFloat(getComputedStyle(el).fontSize);
        if (size < min) bad.push(`${el.tagName.toLowerCase()}[${el.type}] at ${size}px`);
      }
      return bad;
    }, MIN_FIELD_FONT);

    expect(tooSmall, `${route} has fields under ${MIN_FIELD_FONT}px`).toEqual([]);
  }
});

test("orders shows one status at a time", async () => {
  await visit("/orders");

  const board = page.getByRole("tablist", { name: "Order status" });
  await expect(board).toBeVisible();

  // The seeded order is waiting in New, and it is the only panel on screen —
  // which is the point of the segmented control.
  await expect(page.getByRole("tabpanel")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Table 7" })).toBeVisible();

  await board.getByRole("tab", { name: /Ready/ }).click();
  await expect(board.getByRole("tab", { name: /Ready/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // Switching lanes puts the New order away rather than stacking both.
  await expect(page.getByRole("heading", { name: "Table 7" })).toBeHidden();
  await expectNoSideScroll(page, "/orders");
});

test("the menu preview opens full width", async () => {
  await visit("/templates");
  await page.getByRole("button", { name: "Preview" }).click();

  const sheet = page.getByRole("dialog", { name: "Preview" });
  await expect(sheet).toBeVisible();

  // Full-bleed: the diner's menu at the real width, not a phone drawn inside
  // a phone.
  const box = await sheet.boundingBox();
  const width = page.viewportSize()!.width;
  expect(box!.width).toBeGreaterThanOrEqual(width - 1);

  await page.screenshot({ path: `${SHOTS}/preview.png` });
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toBeHidden();
});

test("a confirmation is an action sheet with full-width buttons", async () => {
  await visit("/dashboard");
  await tabBar().getByRole("button", { name: "More" }).click();
  await page
    .getByRole("dialog", { name: "More sections" })
    .getByRole("button", { name: "Sign out" })
    .click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();

  const box = await dialog.boundingBox();
  const view = page.viewportSize()!;
  // Anchored to the bottom edge, spanning the width.
  expect(box!.width).toBeGreaterThanOrEqual(view.width - 1);
  expect(box!.y + box!.height).toBeGreaterThan(view.height * 0.6);

  const cancel = await dialog.getByRole("button", { name: "Cancel" }).boundingBox();
  expect(cancel!.height).toBeGreaterThanOrEqual(MIN_TARGET);

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("the whole dashboard is legible at a glance", async () => {
  for (const route of ROUTES) {
    await visit(route);
    // A screenshot of a page still fetching shows the word "Loading…" and
    // nothing that could be reviewed, which defeats the point of taking one.
    await expect(page.getByText("Loading…")).toBeHidden({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/${route.slice(1)}.png`, fullPage: true });
  }
});
