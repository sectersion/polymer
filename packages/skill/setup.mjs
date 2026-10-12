#!/usr/bin/env node
/**
 * `polymer-setup` — one-command local bootstrap: boot a Polymer server
 * (daemonized, pidfile-managed), capture the first-run master
 * credential off its stderr, log in over REST, mint an init OTP,
 * enroll an agent (via install.mjs, the tested unit), and verify the
 * session answers. Secrets never touch stdout — identifiers only.
 *
 * Usage:
 *   polymer-setup --name AGENT [--dir DIR] [--db PATH] [--port PORT]
 *   polymer-setup --stop [--dir DIR]
 *   polymer-setup --status [--dir DIR]
 *
 * State lives next to --dir (repo-local by decision): .polymrc (the
 * agent), polymer.db (default), .polymer-server.json (daemon meta),
 * .polymer-server.pid, polymer-server.log (append-only; no rotation in
 * this slice — it only receives error lines and periodic job notes). An existing healthy daemon
 * is reused, never duplicated; reruns are idempotent.
 */

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "usage: polymer-setup --name AGENT [--dir DIR] [--db PATH] [--port PORT]",
    "       polymer-setup --stop [--dir DIR]",
    "       polymer-setup --status [--dir DIR]",
    "",
    "Boot a local Polymer server (daemonized) and enroll an agent.",
    "Re-runs reuse a healthy daemon and existing credentials.",
  ].join("\n");
}

function fail(status, message) {
  console.error(`polymer-setup: ${message}`);
  process.exit(status);
}

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

function metaPaths(dir) {
  return {
    pid: join(dir, ".polymer-server.pid"),
    meta: join(dir, ".polymer-server.json"),
    log: join(dir, "polymer-server.log"),
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthOk(url) {
  try {
    const res = await fetch(`${url}/health`);
    return res.status === 200;
  } catch {
    return false;
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Locate the built server: explicit flag, npm layout, repo layout. */
function findServerEntry(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) {
      fail(1, `server entry not found: ${explicit}`);
    }
    return explicit;
  }
  const candidates = [
    join(HERE, "..", "server", "dist", "index.js"),
    join(HERE, "..", "..", "apps", "server", "dist", "index.js"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function runChild(entry, args, extraEnv = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      env: { ...process.env, ...extraEnv },
      timeout: 120000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) =>
      resolvePromise({ status: status ?? 1, stdout, stderr }),
    );
  });
}

async function waitHealthy(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await healthOk(url)) return true;
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
}

/** First boot prints the master once; initialized servers print nothing. */
async function captureMaster(logPath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const pattern =
    /polymer master credential \(save it now; it is not shown again\): (\S+)/;
  for (;;) {
    if (existsSync(logPath)) {
      const match = pattern.exec(readFileSync(logPath, "utf8"));
      if (match) return match[1];
    }
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}

async function stopDaemon(dir) {
  const { pid, meta } = metaPaths(dir);
  if (!existsSync(pid)) {
    console.log(JSON.stringify({ ok: true, running: false, dir }));
    return;
  }
  const pidNum = Number(readFileSync(pid, "utf8").trim());
  if (Number.isInteger(pidNum) && pidAlive(pidNum)) {
    process.kill(pidNum, "SIGTERM");
    const deadline = Date.now() + 10000;
    while (pidAlive(pidNum) && Date.now() < deadline) {
      await sleep(150);
    }
    if (pidAlive(pidNum)) fail(1, `daemon pid ${pidNum} would not stop`);
  }
  for (const path of [pid, meta]) {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  }
  console.log(JSON.stringify({ ok: true, running: false, dir }));
}

async function statusDaemon(dir) {
  const { pid, meta } = metaPaths(dir);
  const info = existsSync(meta) ? readJson(meta) : null;
  const pidNum = existsSync(pid)
    ? Number(readFileSync(pid, "utf8").trim())
    : NaN;
  const running = Number.isInteger(pidNum) && pidAlive(pidNum);
  const healthy = running && info?.url ? await healthOk(info.url) : false;
  console.log(
    JSON.stringify({ ok: true, running, healthy, dir, url: info?.url ?? null }),
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    return;
  }
  const dir = resolve(argOf(argv, "--dir") ?? ".");
  if (argv.includes("--stop")) {
    await stopDaemon(dir);
    return;
  }
  if (argv.includes("--status")) {
    await statusDaemon(dir);
    return;
  }
  const name = argOf(argv, "--name");
  if (!name) fail(2, `missing --name\n${usage()}`);
  const dbPath = resolve(argOf(argv, "--db") ?? join(dir, "polymer.db"));
  const installer = join(HERE, "install.mjs");

  // Reuse a healthy daemon; otherwise boot one (detached, pidfile).
  const paths = metaPaths(dir);
  let url = null;
  const existing = existsSync(paths.meta) ? readJson(paths.meta) : null;
  if (existing?.url && (await healthOk(existing.url))) {
    url = existing.url;
  } else {
    if (existsSync(paths.pid)) {
      try {
        unlinkSync(paths.pid);
      } catch {
        // Stale pidfile from a dead daemon; the boot below replaces it.
      }
    }
    const entry = findServerEntry(argOf(argv, "--server-entry"));
    if (!entry) {
      fail(
        1,
        "no built server found (looked for --server-entry, npm and repo layouts); run pnpm --filter @polymer/server build first",
      );
    }
    let port = Number(argOf(argv, "--port") ?? "8080");
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      fail(2, `--port must be 1-65535`);
    }
    url = `http://127.0.0.1:${port}`;
    if (await healthOk(url)) {
      // Something else already answers there: pick a free port instead
      // of evicting a stranger.
      port = await freePort();
      url = `http://127.0.0.1:${port}`;
    }
    const logFd = openSync(paths.log, "a");
    const daemon = spawn(process.execPath, [entry, "--port", String(port)], {
      env: { ...process.env, POLYMER_DATABASE_PATH: dbPath },
      detached: true,
      stdio: ["ignore", "ignore", logFd],
    });
    daemon.unref();
    try {
      closeSync(logFd);
    } catch {
      // The daemon inherited the fd; our copy is best-effort.
    }
    if (!(await waitHealthy(url))) {
      fail(1, `server never became healthy at ${url} (see ${paths.log})`);
    }
    writeFileSync(
      paths.meta,
      `${JSON.stringify({ url, dbPath, startedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    writeFileSync(paths.pid, `${daemon.pid ?? 0}\n`);
    chmodSync(paths.pid, 0o600);
  }

  // Enroll (idempotent fast path inside install.mjs when possible).
  const master = await captureMaster(paths.log, 8000);
  let otp = null;
  if (master !== null) {
    const login = await fetch(`${url}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ master_credential: master }),
    });
    if (login.status !== 200) fail(1, "admin login failed on fresh server");
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0].trim();
    const { csrf_token } = await login.json();
    const mint = await fetch(`${url}/api/tokens/init`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf_token,
      },
      body: "{}",
    });
    if (mint.status !== 200) fail(1, "OTP mint failed on fresh server");
    otp = await mint.json();
  }
  const installArgs = ["--server", url, "--dir", dir, "--name", name];
  if (otp !== null) {
    installArgs.push(
      "--init-token-id",
      otp.init_token_id,
      "--init-token",
      otp.init_token,
    );
  }
  const enrolled = await runChild(installer, installArgs);
  if (enrolled.status !== 0) {
    fail(
      1,
      `enrollment failed${master === null ? " (server already initialized and no working credentials; ask your admin for OTPs and run polymer-install)" : ""}: ${enrolled.stderr.trim().split("\n").pop()}`,
    );
  }
  const verified = await runChild(join(HERE, "status.mjs"), ["--dir", dir]);
  if (verified.status !== 0) {
    fail(1, `enrolled but verification failed: ${verified.stderr.trim()}`);
  }
  const agentId = JSON.parse(verified.stdout).agent_id;
  console.log(
    JSON.stringify({
      ok: true,
      server: url,
      agent: name,
      agent_id: agentId,
      dir,
      db: dbPath,
    }),
  );
}

await main();
