#!/usr/bin/env node
/**
 * scripts/demo/capture.mjs — orchestrates the demo capture (issue #61).
 *
 *   1. boot the seeded stack (scripts/demo/seed.mjs)
 *   2. re-arm a fresh 25s lease on the live-act task (mason), so the
 *      expiry counts down on camera nearby
 *   3. run both acts in lockstep:
 *        terminal act — vhs scripts/demo/wren.tape (wren claims after
 *        expiry, works, completes)
 *        console act  — playwright video: board → detail → tokens
 *   4. assemble docs/demo.mp4 (acts concatenated) and docs/demo.gif
 *
 * Usage: node scripts/demo/capture.mjs
 */
import { spawn, execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CAPDIR = process.env.POLYMER_CAPTURE_DIR ?? "/tmp/opencode";
const BIN = `${CAPDIR}/bin`;
const sdkRequire = createRequire(join(REPO, "packages/skill/package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);
const out = (...a) => console.error("[capture]", ...a);
const STATE = `${CAPDIR}/demo-state.json`;

function run(cmd, args, name) {
  const child = spawn(cmd, args, {
    cwd: REPO,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` },
    detached: false,
  });
  child.stdout.on("data", (c) => process.stderr.write(`[${name}] ${c}`));
  child.stderr.on("data", (c) => process.stderr.write(`[${name}] ${c}`));
  return child;
}

async function masonReclaim(state) {
  const client = new Client({ name: "demo-rearm", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(state.mcp_url), {
      requestInit: {
        headers: { Authorization: `Bearer ${state.tokens.mason}` },
      },
    }),
  );
  try {
    await client.callTool({
      name: "claim_task",
      arguments: {
        task_id: state.tasks.rate_limit_headers,
        lease_duration_seconds: 25,
      },
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  mkdirSync(`${REPO}/docs/demo`, { recursive: true });
  // Clean the previous take's artifacts.
  for (const f of [STATE, `${CAPDIR}/capture-plan.json`]) {
    if (existsSync(f)) rmSync(f);
  }
  for (const v of readdirSync(CAPDIR)) {
    if (/^page@.*\.webm$/.test(v)) {
      rmSync(join(CAPDIR, v), { force: true }); // previous video take
    } else if (v === "demo.mp4") {
      rmSync(join(CAPDIR, v), { force: true });
    }
  }

  out("booting seed stack…");
  const seed = run("node", ["scripts/demo/seed.mjs"], "seed");
  for (let i = 0; i < 150; i += 1) {
    if (existsSync(STATE)) {
      const s = JSON.parse(readFileSync(STATE, "utf8"));
      if (s.tokens?.wren) break; // fully ready (not just server-up)
    }
    await sleep(1000);
  }
  if (!existsSync(STATE)) {
    out("FATAL: seed produced no usable state");
    process.exit(1);
  }
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  out("seeded; web at", state.web_url);

  // Re-arm mason's lease for the camera, then run the acts in lockstep.
  out("re-arming mason's 25s lease…");
  await masonReclaim(state);

  const plan = {
    name: "wren-takes-over",
    per_shot: {
      login_hold_s: 2,
      board_settle_s: 3,
      board_max_wait_s: 135,
      board_hold_s: 5,
      detail_hold_s: 6,
      telemetry_hold_s: 8,
    },
  };
  writeFileSync(`${CAPDIR}/capture-plan.json`, JSON.stringify(plan, null, 2));

  out("→ acts start; lease expires on camera at ~60s; wren claims after");
  const acts = [
    run(`${BIN}/vhs`, ["scripts/demo/wren.tape"], "vhs"),
    run("node", ["scripts/demo/capture-console.mjs"], "console"),
  ];
  const codes = await Promise.all(
    acts.map((c) => new Promise((r) => c.on("close", (code) => r(code)))),
  );
  out("acts closed with codes", codes.join(","));

  seed.kill("SIGINT");
  await sleep(2000);

  if (codes.some((c) => c !== 0)) {
    out("an act failed — skipping assembly");
    process.exit(1);
  }

  // Playwright writes the video flat: page@<hash>.webm in CAPDIR.
  const videoFile = readdirSync(CAPDIR).find((v) => /^page@.*\.webm$/.test(v));
  if (!videoFile) {
    out("FATAL: playwright video not found");
    process.exit(1);
  }

  // Terminal act onto the console frame; concatenate; then palette GIF.
  const filt =
    "[0:v]fps=12,scale=1600:900:force_original_aspect_ratio=decrease," +
    "pad=1600:900:(ow-iw)/2:(oh-ih)/2:color=#161b22,setsar=1,format=yuv420p[term];" +
    "[1:v]fps=12,setsar=1,format=yuv420p[cons];" +
    "[term][cons]concat=n=2:v=1:a=0[out]";
  execSync(
    `ffmpeg -y -i docs/demo/wren-terminal.gif -i ${CAPDIR}/${videoFile} ` +
      `-filter_complex "${filt}" -map "[out]" -r 12 -c:v libx264 -preset medium -crf 23 ${CAPDIR}/demo.mp4`,
    { stdio: "inherit", cwd: REPO },
  );
  execSync(`ffmpeg -y -i ${CAPDIR}/demo.mp4 -c copy ${REPO}/docs/demo.mp4`, {
    stdio: "inherit",
  });
  // Two-pass palette GIF for the README.
  execSync(
    `set -e; P=$(mktemp ${CAPDIR}/pal.XXXX.png); ` +
      `ffmpeg -y -i ${REPO}/docs/demo.mp4 -vf "fps=10,scale=1300:-1:flags=lanczos,palettegen=max_colors=128" "$P"; ` +
      `ffmpeg -y -i ${REPO}/docs/demo.mp4 -i "$P" -lavfi "fps=10,scale=1300:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" ${REPO}/docs/demo.gif; ` +
      `rm "$P"`,
    { stdio: "inherit", shell: "/bin/bash" },
  );
  out("assembled: docs/demo.mp4 + docs/demo.gif");
}

await main();
