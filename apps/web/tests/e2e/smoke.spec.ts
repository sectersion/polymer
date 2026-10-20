import { expect, test } from "@playwright/test";

/**
 * The admin surface smoke (issue #43): login → onboarding mints an
 * OTP → the seeded task is on the board → the roster shows the
 * seeded agent's heartbeat. One spec, sequential, against a real
 * backend seeded by global-setup.mjs; the app is the production
 * (standalone) build.
 */
test("admin console smoke: login, onboard, fleet, roster", async ({ page }) => {
  // Set by globalSetup after config load — never read at module scope.
  const base = process.env.WEB_E2E_CONSOLE_URL;
  if (base === undefined) {
    throw new Error("global setup did not set WEB_E2E_CONSOLE_URL");
  }

  // Session gate: an unauthenticated visitor lands on Login.
  await page.goto(`${base}/`);
  await page.waitForURL("**/login");

  // Login: one password field for the master credential.
  await page
    .getByLabel("Master credential")
    .fill(process.env.WEB_E2E_MASTER_CREDENTIAL ?? "");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(`${base}/`);

  // Onboarding: "Mint init token" renders a single-use OTP prompt.
  await page.goto(`${base}/onboarding`);
  await page.getByRole("button", { name: "Mint init token" }).click();
  // The toast copy block and the on-page enroll prompt both echo the
  // minted OTP; either showing is the flow working.
  await expect(
    page.getByText("POLYMER_INIT_TOKEN_ID=", { exact: false }).first(),
  ).toBeVisible();

  // The board shows the seeded task (created via MCP before the
  // browser ever connects — the real agent-side flow).
  await page.goto(`${base}/tasks`);
  await expect(page.getByText("playwright smoke task")).toBeVisible();

  // The roster shows the seeded agent and its live status.
  await page.goto(`${base}/agents`);
  await expect(page.getByText("smoke-agent")).toBeVisible();
});

test("dark mode follows prefers-color-scheme and stays token-clean", async ({
  page,
}) => {
  // Prove the system path end to end: the browser asks for dark via
  // prefers-color-scheme and the mounted console resolves the same
  // token names to the dark set (no light artifacts hardcoded).
  const base = process.env.WEB_E2E_CONSOLE_URL;
  if (base === undefined) {
    throw new Error("global setup did not set WEB_E2E_CONSOLE_URL");
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${base}/login`);
  // next-themes puts the theme class on <html> (attribute="class").
  const html = page.locator("html");
  await expect(html).toHaveClass(/dark/, { timeout: 15000 });
  // Resolved token, not a hardcoded light gray: the canvas token in
  // dark is #0d1117, never the light #f6f8fa.
  const canvas = await page
    .locator("body")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(canvas).toBe("rgb(13, 17, 23)");
  // The toggle persists a manual light choice back over the system
  // preference (localStorage — next-themes storageKey "theme"); the
  // toggle lives in the console chrome, so log in first.
  await page
    .getByLabel("Master credential")
    .fill(process.env.WEB_E2E_MASTER_CREDENTIAL ?? "");
  await page.getByRole("button", { name: "Log in" }).click();
  await page.waitForURL(`${base}/`);
  await page.getByLabel("Light theme").click();
  await expect(html).not.toHaveClass(/dark/, { timeout: 15000 });
  // Back on the light set: canvas flips to the light token value.
  const lightCanvas = await page
    .locator("body")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightCanvas).toBe("rgb(246, 248, 250)");
});
