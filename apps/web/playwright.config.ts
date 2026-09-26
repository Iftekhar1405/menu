import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  /*
   * Generous on purpose. These are ceilings, not waits — a passing run is no
   * slower for them. They are this high because the suite is just as likely
   * to be pointed at a hosted database as at the local Docker Postgres:
   * against a remote one every write costs three to five seconds and every
   * read about two, so a test making twenty round trips needs well past a
   * minute before a timeout means anything other than "the network is far
   * away".
   */
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "off",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile\.spec\.ts/,
    },
    // The dashboard is worked from a phone during service as often as from a
    // laptop, so the phone viewport is a first-class target rather than a
    // narrower window of the desktop one. Its spec asserts the things that
    // only go wrong at that width, so it runs there and nowhere else.
    {
      name: "mobile",
      use: { ...devices["iPhone 13"] },
      testMatch: /mobile\.spec\.ts/,
    },
  ],
});
