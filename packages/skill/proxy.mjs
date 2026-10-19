#!/usr/bin/env node
/**
 * `polymer-proxy` — stdio bridge for MCP clients that cannot resolve
 * environment-based header auth. OpenCode's shared background service
 * owns remote MCP connections and does not inherit the agent shell's
 * environment, so `{env:POLYMER_SESSION_TOKEN}` header substitution
 * arrives empty; a `local` server entry running this bridge instead
 * reads credentials straight from `.polymrc` (the source of truth)
 * and attaches the Bearer itself. Secrets never appear in argv, env,
 * config files, or logs.
 *
 * Downstream: MCP over stdio (initialize, ping, tools/*).
 * Upstream: Streamable HTTP with `Authorization: Bearer <session>`.
 *
 * Usage: polymer-proxy [--dir DIR] [--server URL] [--mcp-path PATH]
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  PingRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

function fail(message) {
  console.error(`polymer-proxy: ${message}`);
  process.exit(1);
}

const dir = resolve(argOf(process.argv, "--dir") ?? ".");
const mcpPath = argOf(process.argv, "--mcp-path") ?? "/mcp";

const rcPath = join(dir, ".polymrc");
let rc = null;
try {
  rc = JSON.parse(readFileSync(rcPath, "utf8"));
} catch {
  fail(`no usable credentials: ${rcPath} is missing or unreadable (run polymer-install first)`);
}
const server = argOf(process.argv, "--server") ?? rc.server;
if (!server || typeof rc.session_token !== "string") {
  fail(
    "no usable credentials: need .polymrc with server + session_token " +
      "(run polymer-install first)",
  );
}

/** Upstream connection, created lazily on the first request. */
let upstream = null;

async function getUpstream() {
  if (upstream) return upstream;
  const client = new Client({ name: "polymer-proxy", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server}${mcpPath}`), {
      requestInit: {
        headers: { Authorization: `Bearer ${rc.session_token}` },
      },
    }),
  );
  upstream = client;
  return client;
}

const downstream = new Server(
  { name: "polymer", version: "0.0.0" },
  { capabilities: { tools: {} } },
);

downstream.setRequestHandler(InitializeRequestSchema, async (request) => {
  // SDK 1.32's connect() runs the upstream handshake itself; report
  // the bridge as the downstream server, passing through the server's
  // instructions so hosts surface them.
  const client = await getUpstream();
  return {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "polymer", version: "0.0.0" },
    ...(client.getInstructions() !== undefined
      ? { instructions: client.getInstructions() }
      : {}),
  };
});

downstream.setRequestHandler(PingRequestSchema, async () => {
  const client = await getUpstream();
  await client.callTool({ name: "ping", arguments: {} });
  return {};
});

downstream.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const client = await getUpstream();
  return client.listTools(request.params ?? {});
});

downstream.setRequestHandler(CallToolRequestSchema, async (request) => {
  const client = await getUpstream();
  return client.callTool(request.params);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

await downstream.connect(new StdioServerTransport());
