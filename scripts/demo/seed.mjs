#!/usr/bin/env node
/**
 * scripts/demo/seed.mjs — boot a throwaway Polymer stack (server + web
 * console) and seed the take-2 story: two enrolled agents, two open
 * tasks, one done task so the board looks lived-in.
 *
 * Writes $POLYMER_CAPTURE_DIR/demo-state.json, then stays alive until
 * SIGINT/SIGTERM so the act and camera can run against it.
 *
 * Usage: node scripts/demo/seed.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkRequire = createRequire(join(REPO, "packages/skill/package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const CAPDIR = process.env.POLYMER_CAPTURE_DIR ?? "/tmp/opencode";
const SERVER_PORT = 8891;
const WEB_PORT = 8892;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const MCP_URL = `${SERVER_URL}/mcp`;
const API_URL = `${SERVER_URL}/api`;
const STATE_PATH = `${CAPDIR}/demo-state.json`;

const out = (...rest) => console.error("[seed]", ...rest);

function bootServer() {
  return new Promise((resolveBoot) => {
    const dir = mkdtempSync(join(tmpdir(), "polymer-demo-"));
    const child = spawn(
      process.execPath,
      [join(REPO, "apps/server/dist/index.js"), "--port", String(SERVER_PORT)],
      {
        env: {
          ...process.env,
          POLYMER_DATABASE_PATH: join(dir, "polymer.db"),
        },
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c;
      const m = stderr.match(/master credential[^:]*:\s*([0-9a-f]+)/);
      if (m) resolveBoot({ child, master: m[1] });
    });
  });
}

/** Thin MCP client wrapper; no header when unauthenticated. */
async function mcp(token, fn) {
  const client = new Client({ name: "demo-seed", version: "0.0.0" });
  const headers =
    token === undefined ? {} : { Authorization: `Bearer ${token}` };
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers },
    }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** One OTLP span per LLM call — cost rows join via polymer.task_id. */
async function emitSpan(token, who, taskId, opts = {}) {
  const nowNs = `${Date.now() * 1_000_000}`;
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  await fetch(`${SERVER_URL}/otel/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: who } }],
          },
          scopeSpans: [
            {
              scope: { name: "demo-agent", version: "0.1.0" },
              spans: [
                {
                  traceId: "5b8efff798038105d7f39f9d3b8d3f52",
                  spanId,
                  name: opts.name ?? "completed — model call",
                  kind: 1,
                  startTimeUnixNano: nowNs,
                  endTimeUnixNano: `${BigInt(nowNs) + 1_500_000_000n}`,
                  attributes: [
                    {
                      key: "gen_ai.request.model",
                      value: { stringValue: "claude-sonnet-4-5" },
                    },
                    {
                      key: "gen_ai.provider.name",
                      value: { stringValue: "opencode-go" },
                    },
                    {
                      key: "gen_ai.usage.input_tokens",
                      value: { intValue: String(opts.input ?? 3117) },
                    },
                    {
                      key: "gen_ai.usage.output_tokens",
                      value: { intValue: String(opts.output ?? 864) },
                    },
                    {
                      key: "gen_ai.usage.cost_micro_usd",
                      value: { intValue: String(opts.cost ?? 10421) },
                    },
                    { key: "polymer.task_id", value: { stringValue: taskId } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  });
}

async function main() {
  const { child: server, master } = await bootServer();
  out("server up, master credential captured");

  for (let i = 0; i < 50; i += 1) {
    const r = await fetch(`${SERVER_URL}/health`).catch(() => null);
    if (r?.status === 200) break;
    await sleep(200);
  }

  const login = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ master_credential: master }),
  });
  if (!login.ok) throw new Error(`login failed: ${login.status}`);
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const { csrf_token: csrf } = await login.json();
  out("admin login ok");

  const web = spawn("pnpm", ["--filter", "@polymer/web", "start"], {
    cwd: REPO,
    env: {
      ...process.env,
      WEB_PORT: String(WEB_PORT),
      POLYMER_API_URL: SERVER_URL,
      PORT: String(WEB_PORT),
    },
  });
  web.stdout.on("data", (c) => process.stderr.write(`[web] ${c}`));
  web.stderr.on("data", (c) => process.stderr.write(`[web:err] ${c}`));
  for (let i = 0; i < 150; i += 1) {
    const r = await fetch(WEB_URL).catch(() => null);
    if (r?.status === 200) break;
    await sleep(300);
  }
  out("web console at", WEB_URL);

  const otps = [];
  for (const name of ["wren", "mason"]) {
    const r = await fetch(`${API_URL}/tokens/init`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ label: name }),
    });
    if (!r.ok) throw new Error(`tokens/init ${name}: ${r.status}`);
    otps.push({ name, ...(await r.json()) });
  }

  const agents = {};
  for (const { name, init_token_id: id, init_token: secret } of otps) {
    const reg = await mcp(undefined, (c) =>
      c.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: id,
          init_token: secret,
          name,
          role: "coder",
        },
      }),
    );
    agents[name] = {
      token: reg.structuredContent.session_token,
      agent_id: reg.structuredContent.agent_id,
    };
    await mcp(agents[name].token, (c) =>
      c.callTool({ name: "send_heartbeat", arguments: {} }),
    );
  }
  out("enrolled wren, mason");

  const T = (n) => agents[n].token;
  const create = async (who, title, description) =>
    (
      await mcp(T(who), (c) =>
        c.callTool({
          name: "create_task",
          arguments: { title, description },
        }),
      )
    ).structuredContent.task_id;

  // Lived-in history: one done task with a cost row.
  const done = await create(
    "mason",
    "Fix flaky a11y test screenshot diff",
    "Root cause and fix for the screenshot-diff flake.",
  );
  await mcp(T("mason"), (c) =>
    c.callTool({ name: "claim_task", arguments: { task_id: done } }),
  );
  const detail = await mcp(T("mason"), (c) =>
    c.callTool({ name: "get_task_detail", arguments: { task_id: done } }),
  ).then((d) => d.structuredContent);
  await mcp(T("mason"), (c) =>
    c.callTool({
      name: "update_task_status",
      arguments: {
        task_id: done,
        status: "done",
        lease_generation: detail.lease_generation,
        expected_version: detail.version,
      },
    }),
  );
  await emitSpan(T("mason"), "mason", done);
  out("history: one done task");

  // The live story: two open tasks. The act claims the first.
  const rateLimit = await create(
    "wren",
    "Add rate-limit headers to /api/*",
    "Retry-After + X-RateLimit-* on 429s; document in the error catalog.",
  );
  const logging = await create(
    "mason",
    "Tighten claim-lease contention logging",
    "Lease conflicts should log contender identity at debug.",
  );
  out("armed: two open tasks");

  const state = {
    master,
    cookie,
    server_url: SERVER_URL,
    web_url: WEB_URL,
    mcp_url: MCP_URL,
    agents: Object.fromEntries(
      Object.entries(agents).map(([k, v]) => [k, v.agent_id]),
    ),
    tokens: { wren: agents["wren"].token, mason: agents["mason"].token },
    tasks: { rate_limit_headers: rateLimit, contention_logging: logging },
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(JSON.stringify({ ok: true, state_path: STATE_PATH }));

  const cleanup = () => {
    out("shutting down");
    web.kill("SIGTERM");
    server.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  setInterval(() => {}, 1 << 30);
}

await main();
