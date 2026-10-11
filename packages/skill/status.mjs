#!/usr/bin/env node
/**
 * `polymer-status` — read-only connectivity check: authenticated
 * `ping` plus a roster peek (agent count). Prints identifiers only,
 * never secrets. Exit 0 when the server answers, 1 otherwise.
 *
 * Config: POLYMER_SERVER / POLYMER_SESSION_TOKEN env first, then
 * `.polymrc` in --dir (default: working directory).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveConfig, resolveDir } from "./config.mjs";

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: polymer-status [--dir DIR]");
    return;
  }
  const dir = resolveDir(argOf(argv, "--dir"));
  const config = resolveConfig(dir);
  if (!config.server || !config.sessionToken) {
    console.error(
      "polymer-status: no server/session configured (set POLYMER_SERVER + POLYMER_SESSION_TOKEN or enroll into --dir first)",
    );
    process.exit(1);
  }
  const client = new Client({ name: "polymer-status", version: "0.0.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${config.server}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${config.sessionToken}` },
        },
      }),
    );
    const ping = await client.callTool({ name: "ping", arguments: {} });
    if (ping?.isError || ping?.structuredContent?.ok !== true) {
      throw new Error("ping rejected");
    }
    const roster = await client.callTool({
      name: "get_agent_roster",
      arguments: {},
    });
    if (roster?.isError || !Array.isArray(roster?.structuredContent?.agents)) {
      throw new Error("roster rejected");
    }
    console.log(
      JSON.stringify({
        ok: true,
        server: config.server,
        agent_id: ping.structuredContent.agent_id ?? config.agentId ?? null,
        agents_seen: roster.structuredContent.agents.length,
      }),
    );
  } catch (err) {
    console.error(`polymer-status: ${err.message}`);
    process.exit(1);
  } finally {
    await client.close().catch(() => {});
  }
}

await main();
