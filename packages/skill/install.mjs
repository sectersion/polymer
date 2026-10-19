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
 * - Host-native MCP client config, no secrets, safe to track:
 *   `opencode.json` for --client opencode (merged into an existing
 *   config, `mcp.servers.polymer` entry); `.mcp.json` for --client
 *   claude (from mcp.json.template). The Bearer travels via
 *   `{env:POLYMER_SESSION_TOKEN}` / `${POLYMER_SESSION_TOKEN}` header
 *   substitution, never a literal secret.
 * - `.gitignore`: gains a `.polymrc` line (exact-line match, so
 *   reruns never duplicate it).
 * - `AGENTS.md`: a marker-delimited Polymer section telling the agent
 *   a managed MCP connection exists — so it uses the preconfigured
 *   `polymer` tools instead of hand-rolling HTTP clients.
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
    "--client picks the config format: opencode writes/merges",
    "opencode.json (mcp.servers, type \"remote\"); claude writes",
    '.mcp.json (mcpServers, type "http").',
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

/**
 * Minimal JSONC handling for hand-edited opencode.jsonc files:
 * strip comments and trailing commas so JSON.parse accepts the text.
 * Formatting is not preserved — the file is rewritten as JSON.
 */
function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * The OpenCode entry is a `local` stdio bridge rather than a `remote`
 * entry: OpenCode's shared background service owns remote MCP
 * connections and does not inherit the agent shell's environment, so
 * `{env:...}` header substitution arrives empty (HTTP 401). The
 * bridge reads the Bearer from `.polymrc` directly — no secret in
 * argv, env, or this (tracked) config file.
 */
function opencodeEntry(dir) {
  return {
    type: "local",
    command: [process.execPath, join(HERE, "proxy.mjs"), "--dir", dir],
  };
}

function findOpencodeConfig(dir) {
  for (const rel of [
    "opencode.json",
    "opencode.jsonc",
    join(".opencode", "opencode.json"),
    join(".opencode", "opencode.jsonc"),
  ]) {
    const path = join(dir, rel);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Write or merge the `polymer` server entry into the project's
 * OpenCode config (V2 shape: mcp.servers). An existing entry that
 * differs from ours is an error, never a silent clobber — identical
 * entries make reruns idempotent.
 */
function writeOpencodeConfig(dir, server) {
  const desired = opencodeEntry(dir);
  const path = findOpencodeConfig(dir) ?? join(dir, "opencode.json");
  let config = {};
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    if (text.trim() !== "") {
      try {
        config = JSON.parse(
          path.endsWith(".jsonc") ? stripJsonc(text) : text,
        );
      } catch (err) {
        throw new Error(`cannot parse ${path}: ${err.message}`);
      }
    }
  }
  if (
    typeof config !== "object" ||
    config === null ||
    Array.isArray(config)
  ) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  config.$schema ??= "https://opencode.ai/config.json";
  const mcp = (config.mcp ??= {});
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    throw new Error(`${path}: "mcp" is not an object`);
  }
  const servers = (mcp.servers ??= {});
  if (
    typeof servers !== "object" ||
    servers === null ||
    Array.isArray(servers)
  ) {
    throw new Error(`${path}: "mcp.servers" is not an object`);
  }
  const existing = servers.polymer;
  if (
    existing !== undefined &&
    JSON.stringify(existing) !== JSON.stringify(desired)
  ) {
    throw new Error(
      `${path} already defines a different "polymer" MCP server entry; ` +
        "review it by hand or remove it, then rerun polymer-install",
    );
  }
  servers.polymer = desired;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}

function writeClientConfig(dir, server, client) {
  return client === "claude"
    ? writeMcpJson(dir, server, client)
    : writeOpencodeConfig(dir, server);
}

function agentsMdBlock(server) {
  return [
    "<!-- polymer:start -->",
    "## Polymer fleet MCP (managed by polymer-install)",
    "",
    `A \`polymer\` MCP server is preconfigured for this repo (${server}/mcp).`,
    "",
    "- Use the polymer MCP tools for fleet coordination (ping, get_tasks,",
    "  claim_task, send_heartbeat, post_comment). Do not hand-roll HTTP",
    "  clients against the server.",
    "- Calls authenticate from `.polymrc` automatically (OpenCode runs a",
    "  stdio bridge, `polymer-proxy`; no secrets in config, env, or argv).",
    "  Never paste, log, or commit its contents.",
    "- Read-only connectivity check: `polymer-status`.",
    "<!-- polymer:end -->",
  ].join("\n");
}

/**
 * Append (or refresh, between exact markers) the Polymer section in
 * the target repo's AGENTS.md so an unprimed agent discovers the
 * managed connection without being told in a prompt.
 */
function ensureAgentsMd(dir, server) {
  const path = join(dir, "AGENTS.md");
  const block = agentsMdBlock(server);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const re = /<!-- polymer:start -->[\s\S]*?<!-- polymer:end -->/;
  const match = existing.match(re);
  if (match) {
    if (match[0] === block) return false;
    writeFileSync(path, existing.replace(re, block));
    return true;
  }
  const prefix =
    existing === "" || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
  writeFileSync(path, `${existing}${prefix}${block}\n`);
  return true;
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
    let configPath;
    try {
      configPath = writeClientConfig(dir, server, client);
      ensureAgentsMd(dir, server);
    } catch (err) {
      fail(1, err.message);
    }
    const gitignoreTouched = ensureGitignore(dir);
    console.log(
      JSON.stringify({
        ok: true,
        reenrolled: false,
        server,
        agent: name,
        agent_id: stored.agent_id,
        dir,
        config: configPath,
        env_var: "POLYMER_SESSION_TOKEN",
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
  let configPath;
  try {
    configPath = writeClientConfig(dir, server, client);
    ensureAgentsMd(dir, server);
  } catch (err) {
    fail(1, err.message);
  }
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
      config: configPath,
      env_var: "POLYMER_SESSION_TOKEN",
      gitignore_touched: gitignoreTouched,
    }),
  );
}

await main();
