#!/usr/bin/env node
/**
 * scripts/demo/capture.mjs — the console act, one camera, one story.
 *
 * Boot: node scripts/demo/seed.mjs (waits for demo-state.json)
 * Then: act (scripts/demo/act.mjs) + camera below run in lockstep.
 * The camera polls REST for the flips, so caption cues land on the
 * real transitions — no fixed sleeps around state changes.
 *
 * Route plan (~45s):
 *   /tasks      — TO DO board, claim flips the card live
 *   /tasks/:id  — handoff comment thread
 *   /tasks      — done flips the card live
 *   /telemetry  — cost row joins the trace to the task
 *
 * Assembly: ffmpeg scales and palette-quantizes the camera video;
 * cue timings land in $CAPDIR/cues.json for debugging retakes.
 *
 * Usage: node scripts/demo/capture.mjs
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CAPDIR = process.env.POLYMER_CAPTURE_DIR ?? "/tmp/opencode";
const PW_PATH =
  process.env.POLYMER_PLAYWRIGHT_PATH ??
  `${CAPDIR}/capture/node_modules/playwright/index.mjs`;
const STATE = `${CAPDIR}/demo-state.json`;
const STILLS = `${CAPDIR}/stills`;
const out = (...a) => console.error("[capture]", ...a);

// Capture-session font override: the app's system stack
// (-apple-system, Segoe UI, …) has no counterpart in a headless Linux
// container, and Chromium's last-resort fallback rendered tofu. DejaVu
// ships with the base image, so pin it for the recording only.
const FONT_FIX = `
*{font-family:"DejaVu Sans",sans-serif !important}
code,pre,kbd,samp{font-family:"DejaVu Sans Mono",monospace !important}
`;

async function main() {
  mkdirSync(STILLS, { recursive: true });
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(STATE)) {
      try {
        const s = JSON.parse(readFileSync(STATE, "utf8"));
        if (s.tokens?.wren && s.tasks?.rate_limit_headers) break;
      } catch {
        /* seed still writing */
      }
    }
    await sleep(1000);
  }
  const S = JSON.parse(readFileSync(STATE, "utf8"));
  out("state ready");

  const { chromium } = await import(PW_PATH);
  const browser = await chromium.launch({
    headless: true,
    args: ["--force-device-scale-factor=1"],
  });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: CAPDIR, size: { width: 1600, height: 900 } },
  });
  const page = await context.newPage();
  const T0 = Date.now();
  const cues = {};
  const cue = (name) => {
    cues[name] = (Date.now() - T0) / 1000;
    out(`cue ${name} @ ${cues[name].toFixed(1)}s`);
  };
  const fix = () => page.addStyleTag({ content: FONT_FIX }).catch(() => {});
  const still = (name) =>
    page
      .screenshot({ path: join(STILLS, `${name}.png`) })
      .catch((e) => out("still failed", e.message));

  async function taskDetail() {
    const r = await fetch(
      `${S.server_url}/api/tasks/${S.tasks.rate_limit_headers}`,
      {
        headers: { cookie: S.cookie },
      },
    );
    if (!r.ok) return null;
    return await r.json();
  }
  async function taskStatus() {
    return (await taskDetail())?.status ?? "unknown";
  }
  async function waitFor(status, timeoutS, label) {
    for (let i = 0; i < timeoutS * 2; i += 1) {
      if ((await taskStatus()) === status) {
        out(`${label}: ${status}`);
        return;
      }
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${status} (${label})`);
  }

  await page.goto(`${S.web_url}/login`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator('input[type="password"]').first().fill(S.master);
  const loginButton = page.locator('button[type="submit"]').first();
  await page.waitForFunction(
    `!document.querySelector('button[type="submit"]')?.disabled`,
    { timeout: 10000 },
  );
  await loginButton.click();
  await page.waitForURL((url) => !url.pathname.includes("/login"), {
    timeout: 15000,
  });
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();

  // Beat 1 — the board, two open tasks.
  await page.goto(`${S.web_url}/tasks`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();
  cue("board1");
  await waitFor("in_progress", 30, "claim");
  cue("claimed");
  // The board is server-rendered per navigation — reload to show the flip.
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();
  await sleep(4000);
  await still("board-claimed");

  // Beat 2 — the thread, only after the handoff comment exists.
  for (let i = 0; i < 40; i += 1) {
    if (((await taskDetail())?.comments?.length ?? 0) > 0) break;
    await sleep(500);
  }
  await page.goto(`${S.web_url}/tasks/${S.tasks.rate_limit_headers}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();
  cue("detail");
  await sleep(6000);
  await still("detail-thread");

  // Beat 3 — back on the board for the finish.
  await page.goto(`${S.web_url}/tasks`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();
  cue("board2");
  await waitFor("done", 40, "complete");
  cue("done");
  await page.reload();
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();
  await sleep(3000);
  await still("board-done");

  // Beat 4 — the payoff.
  await page.goto(`${S.web_url}/telemetry`);
  await page.waitForLoadState("networkidle").catch(() => {});
  await fix();
  cue("telemetry");
  await sleep(6000);
  await still("telemetry-cost");

  const end = (Date.now() - T0) / 1000;
  cues.end = end;
  out(`camera wrapped @ ${end.toFixed(1)}s`);
  writeFileSync(`${CAPDIR}/cues.json`, JSON.stringify(cues, null, 2));
  await context.close();
  await browser.close();

  const videoFile = readdirSync(CAPDIR).find((v) => /^page@.*\.webm$/.test(v));
  if (!videoFile) throw new Error("playwright video not found");

  // No burned-in captions: the footage carries the story on its own.
  // Cue timings stay in cues.json for debugging retakes.
  const base =
    `fps=12,scale=1600:900:force_original_aspect_ratio=decrease,` +
    `pad=1600:900:(ow-iw)/2:(oh-ih)/2:color=#0d1117,setsar=1,format=yuv420p`;

  execSync(
    `ffmpeg -y -v error -i ${CAPDIR}/${videoFile} -vf "${base}" -r 12 -c:v libx264 -preset medium -crf 23 ${CAPDIR}/demo.mp4`,
    { stdio: "inherit", cwd: REPO },
  );
  execSync(
    `ffmpeg -y -v error -i ${CAPDIR}/demo.mp4 -c copy ${REPO}/docs/demo.mp4`,
    {
      stdio: "inherit",
    },
  );
  execSync(
    `P=$(mktemp ${CAPDIR}/pal.XXXX.png); ` +
      `ffmpeg -y -v error -i ${REPO}/docs/demo.mp4 -vf "fps=10,scale=1300:-1:flags=lanczos,palettegen=max_colors=128" "$P"; ` +
      `ffmpeg -y -v error -i ${REPO}/docs/demo.mp4 -i "$P" -lavfi "fps=10,scale=1300:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" ${REPO}/docs/demo.gif; ` +
      `rm "$P"`,
    { stdio: "inherit", shell: "/bin/bash" },
  );
  out(
    `assembled: ${(cues.end ?? 0).toFixed(0)}s -> docs/demo.gif + docs/demo.mp4`,
  );
}

await main().catch((e) => {
  console.error("[capture] FATAL", e.message);
  process.exit(1);
});
