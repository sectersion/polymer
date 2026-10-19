#!/usr/bin/env node
/**
 * scripts/demo/seed.mjs — boot a throwaway Polymer stack (server + web
 * console) and seed the demo story:
 *
 *   scout creates the task, claims it, hands off to @mason, goes quiet
 *   mason claims it, gets pulled away (leaves another @wren mention)
 *   wren's camera act: poll → claim AFTER the fire override → span
 *
 * Writes $POLYMER_CAPTURE_DIR/demo-state.json for the capture acts; database
 * lives in /tmp (fully disposable). Stays alive until SIGINT/SIGTERM.

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

const SERVER_PORT = 8891;
const WEB_PORT = 8892;
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
const MCP_URL = `${SERVER_URL}/mcp`;
const API_URL = `${SERVER_URL}/api`;
const STATE_PATH = `${process.env.POLYMER_CAPTURE_DIR ?? "/tmp/opencode"}/demo-state.json`;

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

/** Claim a task (session is the caller), post a closing comment,
 * complete it with fences from fresh detail, and emit one span. */
async function claimAndComplete(token, who, taskId, closing) {
  await mcp(token, (c) =>
    c.callTool({ name: "claim_task", arguments: { task_id: taskId } }),
  );
  await mcp(token, (c) =>
    c.callTool({
      name: "post_comment",
      arguments: { task_id: taskId, content: closing },
    }),
  );
  const detail = await mcp(token, (c) =>
    c.callTool({ name: "get_task_detail", arguments: { task_id: taskId } }),
  ).then((d) => d.structuredContent);
  const st = await mcp(token, (c) =>
    c.callTool({
      name: "update_task_status",
      arguments: {
        task_id: taskId,
        status: "done",
        lease_generation: detail.lease_generation,
        expected_version: detail.version,
      },
    }),
  );
  if (st.isError)
    throw new Error(
      `status ${taskId}: ${JSON.stringify(st.structuredContent)}`,
    );
  await emitSpan(token, who, taskId);
}

async function main() {
  const { child: server, master } = await bootServer();
  out("server up, master credential captured");

  for (let i = 0; i < 50; i += 1) {
    const r = await fetch(`${SERVER_URL}/health`).catch(() => null);
    if (r?.status === 200) break;
    await sleep(200);
  }

  // Admin session: login mints the session cookie + CSRF token.
  const login = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ master_credential: master }),
  });
  if (!login.ok) {
    throw new Error(`login failed: ${login.status}`);
  }
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  const { csrf_token: csrf } = await login.json();
  out("admin login ok (csrf:", typeof csrf === "string", ")");

  // Web console (dist build exists from pnpm build).
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

  // Mint OTPs via admin REST (cookie + CSRF).
  const otps = [];
  for (const name of ["scout", "mason", "wren"]) {
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
  out("minted 3 OTPs");

  // Enroll the agents via MCP register_agent (+ first heartbeat).
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
  out("enrolled scout, mason, wren");

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

  // ---- history (the board looks lived-in) ----
  const a11yFlake = await create(
    "mason",
    "Fix flaky a11y test screenshot diff",
  );
  await claimAndComplete(
    T("mason"),
    "mason",
    a11yFlake,
    "Root cause: a11y test never unmounted; added afterEach(cleanup). 0/8 failures now.",
  );
  out("history: a11y task done");

  // ---- the live-act setup ----
  const rateLimit = await create(
    "scout",
    "Add rate-limit headers to /api/*",
    "Retry-After + X-RateLimit-* on 429s; document in the error catalog.",
  );
  // scout claims (short lease), scaffolds, hands to mason, goes quiet.
  await mcp(T("scout"), (c) =>
    c.callTool({
      name: "claim_task",
      arguments: { task_id: rateLimit, lease_duration_seconds: 60 },
    }),
  );
  await mcp(T("scout"), (c) =>
    c.callTool({
      name: "post_comment",
      arguments: {
        task_id: rateLimit,
        content:
          "Scaffolded the limiter shape; context lives in docs. @mason — better seat for this one, I'm on the outage.",
      },
    }),
  );
  // mason claims the takeover, leaves a fuller note + hands to wren,
  // then goes dark: his lease expires ON CAMERA before wren claims.
  await mcp(T("mason"), (c) =>
    c.callTool({
      name: "claim_task",
      arguments: { task_id: rateLimit, lease_duration_seconds: 75 },
    }),
  );
  await mcp(T("mason"), (c) =>
    c.callTool({
      name: "post_comment",
      arguments: {
        task_id: rateLimit,
        content:
          "Taking it from scout. The limiter shape is right, the headers need the retry_after plumbed through the JSON layer. Outage is eating my day — @wren, transport retry is your street; when my lease lapses it's claimable and I'll ping you.",
      },
    }),
  );
  out(
    "armed: rate-limit held by mason on a 75s lease; wren owns an unread ping",
  );

  const state = {
    master,
    cookie,
    csrf,
    server_url: SERVER_URL,
    web_url: WEB_URL,
    mcp_url: MCP_URL,
    agents: Object.fromEntries(
      Object.entries(agents).map(([k, v]) => [k, v.agent_id]),
    ),
    tokens: {
      wren: agents["wren"].token,
      mason: agents["mason"].token,
      scout: agents["scout"].token,
    },
    tasks: { rate_limit_headers: rateLimit, a11y_flake: a11yFlake },
  };
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  console.log(
    JSON.stringify({ ok: true, state_path: STATE_PATH, web_url: WEB_URL }),
  );

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
