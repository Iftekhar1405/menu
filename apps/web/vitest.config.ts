import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /*
     * `lib` and `components` only. Without an explicit include, vitest's
     * default glob also picks up e2e/*.spec.ts — Playwright specs, which fail
     * at collection because Playwright's `test()` is not vitest's. The two
     * suites are run by different commands: `pnpm test` here, `pnpm e2e`
     * there.
     */
    include: ["{lib,components,app}/**/*.spec.ts"],
    environment: "node",
  },
});
