#!/usr/bin/env node
/**
 * `polymer-refresh` — rotate credentials safely: POST the reconnect
 * secret, then atomically replace `.polymrc` (temp file + rename, so
 * a crash never leaves a half-written credential file), then verify
 * the fresh session with `ping` before reporting success.
 * Persist-then-use ordering throughout: the new secrets are durable
 * before anything discards the old ones. Prints identifiers only.
 */
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readRcFile, resolveConfig, resolveDir } from "./config.mjs";

function argOf(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : (argv[i + 1] ?? null);
}

async function pingWith(server, token) {
  const client = new Client({ name: "polymer-refresh", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const ping = await client.callTool({ name: "ping", arguments: {} });
    return ping?.isError !== true && ping?.structuredContent?.ok === true;
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("usage: polymer-refresh [--dir DIR]");
    return;
  }
  const dir = resolveDir(argOf(argv, "--dir"));
  const config = resolveConfig(dir);
  if (!config.server || !config.reconnectSecret) {
    console.error(
      "polymer-refresh: no server/reconnect credential configured (enroll into --dir first)",
    );
    process.exit(1);
  }
  const { rc } = readRcFile(dir);
  if (rc === null) {
    console.error(
      "polymer-refresh: no .polymrc to rotate (enroll into --dir first)",
    );
    process.exit(1);
  }
  const res = await fetch(`${config.server}/api/tokens/refresh`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.reconnectSecret}`,
      "content-type": "application/json",
    },
    body: "{}",
  });
  if (res.status !== 200) {
    const code = await res
      .json()
      .then((b) => b?.error ?? `http ${res.status}`)
      .catch(() => `http ${res.status}`);
    console.error(`polymer-refresh: rotation refused (${code})`);
    process.exit(1);
  }
  const rotated = await res.json();
  const next = {
    ...rc,
    agent_id: rotated.agent_id ?? rc.agent_id,
    session_token: rotated.session_token,
    reconnect_secret: rotated.reconnect_secret,
    rotated_at: new Date().toISOString(),
  };
  const tmp = `${dir}/.polymrc.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, `${dir}/.polymrc`);
  if (!(await pingWith(config.server, next.session_token))) {
    console.error(
      "polymer-refresh: rotated but the fresh session does not answer",
    );
    process.exit(1);
  }
  console.log(
    JSON.stringify({
      ok: true,
      server: config.server,
      agent_id: next.agent_id,
    }),
  );
}

await main();
