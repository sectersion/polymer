#!/usr/bin/env node
/**
 * Component 30: `polymer-install` — enrollment installer (OTP in,
 * `.polymrc` out). Idempotent and rerunnable: when the directory
 * already holds credentials for the same server + name and the
 * session still answers `ping`, only the config files are rewritten
 * and no OTP is consumed.
 *
 * Writes into --dir (created if missing):
 * - `.polymrc` (mode 0600): server, agent identity, session +
 *   reconnect secrets, OTel endpoint. NEVER logged or printed.
 * - `.mcp.json`: MCP client config from mcp.json.template — server
 *   URL only, no secrets, safe to track.
 * - `.gitignore`: gains a `.polymrc` line (exact-line match, so
 *   reruns never duplicate it).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "usage: polymer-install --server URL --name AGENT [--role ROLE]",
    "                      --init-token-id ID --init-token OTP --dir DIR",
    "                      [--mcp-path /mcp] [--client opencode|claude]",
    "",
    "Enroll an agent on a Polymer server. OTP arguments are required",
    "only when no working credentials exist yet for --server/--name.",
    "--client picks the .mcp.json transport type (opencode wants",
    '"remote", Claude Code wants "http").',
  ].join("\n");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for ${arg}`);
    }
    out[key] = value;
    i += 1;
  }
  return out;
}

function fail(status, message) {
  console.error(`polymer-install: ${message}`);
  process.exit(status);
}

function readRc(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function withClient(server, mcpPath, token, fn) {
  const headers =
    token === undefined ? {} : { Authorization: `Bearer ${token}` };
  const client = new Client({ name: "polymer-install", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server}${mcpPath}`), {
      requestInit: { headers },
    }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

async function pingOk(server, mcpPath, token) {
  try {
    const result = await withClient(server, mcpPath, token, (client) =>
      client.callTool({ name: "ping", arguments: {} }),
    );
    return result?.structuredContent?.ok === true;
  } catch {
    return false;
  }
}

async function enroll(server, mcpPath, { initTokenId, initToken, name, role }) {
  const result = await withClient(server, mcpPath, undefined, (client) =>
    client.callTool({
      name: "register_agent",
      arguments: {
        init_token_id: initTokenId,
        init_token: initToken,
        name,
        role,
      },
    }),
  );
  if (result?.isError) {
    throw new Error(
      `registration failed: ${JSON.stringify(result.structuredContent ?? result.content ?? result)}`,
    );
  }
  const content = result?.structuredContent;
  if (
    !content?.agent_id ||
    !content?.session_token ||
    !content?.reconnect_secret
  ) {
    throw new Error("registration failed: malformed register_agent response");
  }
  return content;
}

function writeMcpJson(dir, server, client) {
  const template = readFileSync(join(HERE, "mcp.json.template"), "utf8");
  writeFileSync(
    join(dir, ".mcp.json"),
    `${template
      .replaceAll("${POLYMER_SERVER}", server)
      .replaceAll("${MCP_TYPE}", client === "claude" ? "http" : "remote")
      .trim()}\n`,
  );
}

function ensureGitignore(dir) {
  const path = join(dir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = existing.split("\n");
  if (lines.some((line) => line.trim() === ".polymrc")) return false;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${prefix}.polymrc\n`);
  return true;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    fail(2, `${err.message}\n${usage()}`);
  }
  const server = args.server;
  const name = args.name;
  const role = args.role ?? "coder";
  const dir = resolve(args.dir ?? ".");
  const mcpPath = args["mcp-path"] ?? "/mcp";
  const client = args.client ?? "opencode";
  if (client !== "opencode" && client !== "claude") {
    fail(
      2,
      `--client must be opencode or claude, got ${JSON.stringify(client)}`,
    );
  }
  if (!server || !name) fail(2, `missing required flags\n${usage()}`);
  if (!/^https?:\/\//.test(server)) {
    fail(2, `--server must be an http(s) URL, got ${JSON.stringify(server)}`);
  }
  mkdirSync(dir, { recursive: true });

  // Idempotent fast path: matching credentials that still work only
  // get their config files rewritten — no OTP consumed.
  const rcPath = join(dir, ".polymrc");
  const stored = readRc(rcPath);
  if (
    stored?.server === server &&
    stored?.agent_name === name &&
    typeof stored?.session_token === "string" &&
    (await pingOk(server, mcpPath, stored.session_token))
  ) {
    writeMcpJson(dir, server, client);
    const gitignoreTouched = ensureGitignore(dir);
    console.log(
      JSON.stringify({
        ok: true,
        reenrolled: false,
        server,
        agent: name,
        agent_id: stored.agent_id,
        dir,
        gitignore_touched: gitignoreTouched,
      }),
    );
    return;
  }

  if (!args["init-token-id"] || !args["init-token"]) {
    fail(
      2,
      `no working credentials and no --init-token-id/--init-token\n${usage()}`,
    );
  }
  let enrolled;
  try {
    enrolled = await enroll(server, mcpPath, {
      initTokenId: args["init-token-id"],
      initToken: args["init-token"],
      name,
      role,
    });
  } catch (err) {
    fail(1, err.message);
  }
  const rc = {
    server,
    agent_id: enrolled.agent_id,
    agent_name: name,
    role,
    session_token: enrolled.session_token,
    reconnect_secret: enrolled.reconnect_secret,
    otel_endpoint: `${server}/otel`,
    enrolled_at: new Date().toISOString(),
  };
  writeFileSync(rcPath, `${JSON.stringify(rc, null, 2)}\n`, { mode: 0o600 });
  chmodSync(rcPath, 0o600);
  writeMcpJson(dir, server, client);
  const gitignoreTouched = ensureGitignore(dir);
  // Identifiers only on stdout — secrets stay in `.polymrc`.
  console.log(
    JSON.stringify({
      ok: true,
      reenrolled: stored?.server === server && stored?.agent_name === name,
      server,
      agent: name,
      agent_id: enrolled.agent_id,
      dir,
      gitignore_touched: gitignoreTouched,
    }),
  );
}

await main();
