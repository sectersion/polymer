/// <reference types="node" />
import { defineConfig } from "@playwright/test";

/**
 * Browser smoke for the admin console (issue #43): one spec, one real
 * throwaway backend + the built console (global-setup.mjs), no mocks.
 * Kept out of the vitest matrix (and CI's `tests` job) on purpose —
 * browser install is the slow part — it runs as its own CI job.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60000,
  globalSetup: "tests/e2e/global-setup.mjs",
  expect: { timeout: 10000 },
  use: {
    headless: true,
    // Over plain http the session cookie is `polymer_admin` (the
    // `__Host-` name requires a Secure flag, which http can't carry):
    // the console's proxy handles that fallback, so browser context
    // needs no extra configuration.
    // Navigation URL comes from globalSetup at test time (see below):
    // config-level `baseURL: process.env…` is evaluated before
    // globalSetup runs, so it is deliberately not used here.
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  reporter: process.env.CI ? "list" : "list",
  forbidOnly: Boolean(process.env.CI),
});
