import { test, expect, type Page } from "@playwright/test";

/**
 * Confirmation dialogs.
 *
 * The assertion that matters is the negative one: dismissing must leave the
 * thing intact. A dialog that asks and then deletes anyway is worse than no
 * dialog, because it teaches people to stop reading them.
 */

const PIN = "334455";

async function typePin(page: Page, label: string, digits: string) {
  for (let i = 0; i < digits.length; i++) {
    await page.getByLabel(`${label}, digit ${i + 1} of 6`).fill(digits[i]!);
  }
}

test("destructive actions ask first, and dismissing changes nothing", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Your name").fill("Asha");
  await page.getByLabel("Email or phone number").fill(`confirm${Date.now()}@kumar.test`);
  await typePin(page, "Choose a 6-digit PIN", PIN);
  await page.getByLabel("Business name").fill("Confirm Cafe");
  await page.getByRole("button", { name: "Cafe" }).click();
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Menu", exact: true })).toBeVisible();

  await page.getByPlaceholder("Coffee").fill("Drinks");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // ── Deleting a dish ──────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Add a dish to Drinks" }).click();
  await page.getByLabel("Name").fill("Cold brew");
  await page.getByPlaceholder("140").first().fill("180");
  await page.getByRole("button", { name: "Add dish" }).click();
  await expect(page.getByRole("button", { name: /^Cold brew/ })).toBeVisible();

  await page.getByRole("button", { name: /^Cold brew/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Delete "Cold brew"?')).toBeVisible();

  // Dismissing must leave the dish alone.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: /^Cold brew/ })).toBeVisible();

  // Escape must also dismiss without deleting.
  await page.getByRole("button", { name: /^Cold brew/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("button", { name: /^Cold brew/ })).toBeVisible();

  // Confirming does delete it.
  await page.getByRole("button", { name: /^Cold brew/ }).click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete dish" }).click();
  await expect(page.getByRole("button", { name: /^Cold brew/ })).toHaveCount(0);

  // ── Deleting a section ───────────────────────────────────────────────────
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog").getByText('Delete "Drinks"?')).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("heading", { name: "Drinks" })).toBeVisible();

  // ── Signing out ──────────────────────────────────────────────────────────
  await page.getByRole("button", { name: "Sign out" }).click();
  const signOut = page.getByRole("alertdialog");
  await expect(signOut.getByText("Sign out?")).toBeVisible();

  // Cancel keeps the session: still on a dashboard page afterwards.
  await signOut.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("link", { name: "Menu", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});
