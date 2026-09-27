import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  // The same "@/" the app and tsconfig use. Without it a module under test
  // cannot import anything by its normal path, which pushes logic out of
  // the files it belongs in purely to keep it testable.
  resolve: { alias: { "@": resolve(__dirname) } },
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
