#!/usr/bin/env node
/**
 * `polymer-hook` — Claude Code hook that keeps the enrolled agent
 * visible to Polymer without the model calling any tool (#139).
 *
 * Usage (wired by polymer-install --client claude):
 *   node hook.mjs --dir DIR <session|tool|end>
 * `session` / `end` always send `send_heartbeat`; `tool` is throttled
 * to once per 60s via `DIR/.polymer-hook-stamp` (gitignored by the
 * installer; inside the project dir, not a shared temp path, so no
 * symlink or squatting exposure).
 *
 * Identity comes only from the credential in `.polymrc`; the hook
 * payload on stdin is deliberately never read. Never blocks the
 * session: no stdout, always exit 0, every error swallowed.
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConfig, resolveDir } from "./config.mjs";

const THROTTLE_MS = 60_000;

// exitCode first so even a forced exit reports success; unref'd so a
// normal run still ends naturally (process.exit mid-teardown crashes
// libuv on Windows). Requests also abort cleanly at 4s via the signal.
process.exitCode = 0;
setTimeout(() => process.exit(0), 5000).unref();

try {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--dir");
  const dir = resolveDir(i === -1 ? null : argv[i + 1]);
  const mode = argv.filter((a, j) => !a.startsWith("--") && j !== i + 1)[0];
  const config = resolveConfig(dir);
  if (config.server && config.sessionToken) {
    const stamp = join(dir, ".polymer-hook-stamp");
    const fresh =
      mode === "tool" &&
      existsSync(stamp) &&
      Date.now() - statSync(stamp).mtimeMs < THROTTLE_MS;
    if (!fresh) {
      // Stamp before the attempt so a down server is not retried per tool call.
      try {
        writeFileSync(stamp, "");
      } catch {
        // Unwritable dir: skip throttling, still heartbeat.
      }
      const client = new Client({ name: "polymer-hook", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${config.server}/mcp`), {
          requestInit: {
            signal: AbortSignal.timeout(4000),
            headers: { Authorization: `Bearer ${config.sessionToken}` },
          },
        }),
      );
      await client.callTool({ name: "send_heartbeat", arguments: {} });
      await client.close().catch(() => {});
    }
  }
} catch {
  // Quiet by design.
}
