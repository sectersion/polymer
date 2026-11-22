#!/usr/bin/env node
/**
 * `polymer-heartbeat-hook` — Claude Code hook command that keeps the
 * session visible to Polymer without the model calling any tool.
 * Wire it to SessionStart / PostToolUse / Stop (see hooks/hooks.json).
 *
 * - Identity comes only from the credential (`.polymrc` / env, via
 *   config.mjs). The hook's stdin payload is never read.
 * - Rate-limited client-side: at most one heartbeat per 30s per
 *   enrolled directory, tracked in `.polymrc.heartbeat` next to
 *   `.polymrc`. Calls inside the window make no request.
 * - Never blocks or breaks the session: always exits 0, within a hard
 *   deadline, prints nothing to stdout (SessionStart stdout would be
 *   injected into the model's context) and never prints secrets.
 *
 * Usage: polymer-heartbeat-hook [--dir DIR]
 * DIR defaults to $CLAUDE_PROJECT_DIR, then the working directory.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConfig, resolveDir } from "./config.mjs";

const WINDOW_MS = 30_000;
const DEADLINE_MS = 5_000;

function note(reason) {
  // Fixed reason strings only: no error text, URLs or tokens.
  console.error(`polymer-heartbeat: skipped (${reason})`);
}

function skip(reason) {
  note(reason);
  process.exit(0);
}

// Unref'd: fires only if something still holds the loop open. The
// normal path ends by draining, not process.exit, because exiting
// with a live socket aborts Node on Windows (0xC0000409).
setTimeout(() => skip("deadline"), DEADLINE_MS).unref();

const argv = process.argv.slice(2);
const i = argv.indexOf("--dir");
const dir = resolveDir(
  (i === -1 ? null : argv[i + 1]) ?? process.env.CLAUDE_PROJECT_DIR,
);

try {
  const config = resolveConfig(dir);
  if (!config.server || !config.sessionToken) skip("not enrolled");

  const stampPath = join(dirname(config.rcPath), ".polymrc.heartbeat");
  const now = Date.now();
  let last = NaN;
  try {
    last = Number(readFileSync(stampPath, "utf8"));
  } catch {
    // No stamp yet: first heartbeat.
  }
  if (now >= last && now - last < WINDOW_MS) process.exit(0);
  // Stamp before sending, so concurrent hooks in one window send once.
  writeFileSync(stampPath, String(now));

  const client = new Client({ name: "polymer-heartbeat", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${config.server}/mcp`), {
      requestInit: {
        headers: { Authorization: `Bearer ${config.sessionToken}` },
      },
    }),
  );
  const result = await client.callTool({
    name: "send_heartbeat",
    arguments: {},
  });
  await client.close().catch(() => {});
  if (result?.isError) note("rejected");
} catch {
  note("unreachable");
}
