import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../test/browser",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: "chromium",
    viewport: { width: 1440, height: 1050 },
    trace: "retain-on-failure",
  },
});
