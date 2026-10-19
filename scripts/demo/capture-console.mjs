#!/usr/bin/env node
/**
 * scripts/demo/capture-console.mjs — the console act: Playwright
 * drives the admin console while the worker act runs live against the
 * same server, and records it as webm video.
 *
 * Route plan (routes at the console's real URLs, login with the
 * captured master):
 *   /tasks   — the board: mason's lease expires, wren claims on camera
 *   task detail — the handoff comment thread
 *   /tokens  — cost rows for the finished work
 *
 * Output: $POLYMER_CAPTURE_DIR/console.webm (via Playwright video dir)
 */
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const capDir = process.env.POLYMER_CAPTURE_DIR ?? "/tmp/opencode";
// Playwright lives outside the workspace (installed once by the capture
// setup); override with POLYMER_PLAYWRIGHT_PATH when it moves.
const pwRequire = createRequire(import.meta.url);
const { chromium } = pwRequire(
  process.env.POLYMER_PLAYWRIGHT_PATH ??
    `${capDir}/capture/node_modules/playwright/index.mjs`,
);
const S = JSON.parse(readFileSync(`${capDir}/demo-state.json`, "utf8"));
const state = JSON.parse(readFileSync(`${capDir}/capture-plan.json`, "utf8"));
const out = (...a) => console.error("[console]", ...a);
const pause = (s) => sleep(s * 1000);

const browser = await chromium.launch({
  headless: true,
  args: ["--force-device-scale-factor=1"],
});
const context = await browser.newContext({
  viewport: { width: 1600, height: 900 },
  recordVideo: { dir: capDir, size: { width: 1600, height: 900 } },
});
const page = await context.newPage();

// Login: the console expects the master credential at least once.
await page.goto(`${S.web_url}/login`);
await page.waitForLoadState("networkidle");
out("console loaded");

// Fill the master credential field (best-effort — selector names TBD
// from the actual page; fallback shown in the capture log).
const masterField = page.locator('input[type="password"]').first();
await masterField.fill(S.master);
await page.keyboard.press("Enter");
await page.waitForLoadState("networkidle").catch(() => {});
await pause(state.per_shot.login_hold_s ?? 2);

// Board: the act's main stage — mason's lease expires, wren claims, then done.
await page.goto(`${S.web_url}/tasks`);
await page.waitForLoadState("networkidle");
await pause(state.per_shot.board_settle_s ?? 3);
// Poll the REST API for the rate-limit task's status; the board page
// itself stays live (it shows lease countdowns and status flips).
const maxPolls = Math.ceil((state.per_shot.board_max_wait_s ?? 135) / 3);
for (let i = 0; i < maxPolls; i += 1) {
  const r = await fetch(
    `${S.server_url}/api/tasks/${S.tasks.rate_limit_headers}`,
    {
      headers: { cookie: S.cookie },
    },
  );
  if (r.ok) {
    const body = await r.json();
    if (body.status === "done") break;
    out("board:", body.status, `poll ${i}`);
  }
  await sleep(3000);
}
await pause(state.per_shot.board_hold_s ?? 5);

// Task detail: handoff thread.
const taskId = S.tasks["rate_limit_headers"];
await page.goto(`${S.web_url}/tasks/${taskId}`);
await page.waitForLoadState("networkidle");
await pause(state.per_shot.detail_hold_s ?? 5);

// Telemetry: the payoff (usage/cost rows live here, not on /tokens —
// that page is the credential manager).
await page.goto(`${S.web_url}/telemetry`);
await page.waitForLoadState("networkidle");
await pause(state.per_shot.telemetry_hold_s ?? 8);

await context.close();
await browser.close();
out("console act recorded");
console.log(REPO, state.name ?? "capture");
