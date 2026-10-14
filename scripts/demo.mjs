#!/usr/bin/env node
/**
 * `pnpm demo` — one-command live demo: production server + web console.
 *
 * Boots the built server (SQLite/WAL on disk) and the built Next.js
 * console together, prefixes their logs, and prints the demo URLs.
 * First boot prints the master credential once on stderr — save it,
 * log into the console, mint OTPs on the Onboarding page.
 *
 * Env overrides: POLYMER_PORT (8080), POLYMER_HOST (127.0.0.1),
 * POLYMER_DATABASE_PATH (./polymer.db), WEB_PORT (3000),
 * POLYMER_API_URL (http://127.0.0.1:<server port>).
 * Ctrl-C shuts both down cleanly.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const serverPort = process.env.POLYMER_PORT ?? "8080";
const serverHost = process.env.POLYMER_HOST ?? "127.0.0.1";
const dbPath = process.env.POLYMER_DATABASE_PATH ?? resolve(REPO, "polymer.db");
const webPort = process.env.WEB_PORT ?? "3000";
const apiUrl =
  process.env.POLYMER_API_URL ?? `http://${serverHost}:${serverPort}`;

function pipe(child, prefix) {
  for (const stream of ["stdout", "stderr"]) {
    child[stream]?.setEncoding("utf8");
    child[stream]?.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() === "") continue;
        const out = stream === "stderr" ? process.stderr : process.stdout;
        out.write(`[${prefix}] ${line}\n`);
      }
    });
  }
}

function run(cmd, args, opts, prefix) {
  const child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  pipe(child, prefix);
  return child;
}

const server = run(
  process.execPath,
  ["apps/server/dist/index.js", "--port", String(serverPort)],
  {
    cwd: REPO,
    env: {
      ...process.env,
      POLYMER_HOST: serverHost,
      POLYMER_PORT: String(serverPort),
      POLYMER_DATABASE_PATH: dbPath,
    },
  },
  "server",
);

const web = run(
  "pnpm",
  ["--filter", "@polymer/web", "start", "-p", String(webPort)],
  {
    cwd: REPO,
    env: { ...process.env, PORT: String(webPort), POLYMER_API_URL: apiUrl },
    shell: process.platform === "win32",
  },
  "web",
);

console.log(`polymer demo starting:
  server  http://${serverHost}:${serverPort}  (MCP /mcp, OTLP /otel, REST /api)
  console http://127.0.0.1:${webPort}  (login with the master credential from [server] stderr)
  db      ${dbPath}
press Ctrl-C to stop both.`);

let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\npolymer demo received ${signal}, stopping…`);
  web.kill("SIGTERM");
  server.kill("SIGTERM");
  setTimeout(() => {
    try {
      web.kill("SIGKILL");
    } catch {}
    try {
      server.kill("SIGKILL");
    } catch {}
    process.exit(0);
  }, 5000).unref?.();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

let exited = 0;
for (const [child, name] of [
  [server, "server"],
  [web, "web"],
]) {
  child.once("exit", (code, sig) => {
    console.error(`polymer demo: ${name} exited (code=${code} signal=${sig})`);
    exited += 1;
    if (exited > 0 && !stopping) shutdown("child-exit");
  });
}
