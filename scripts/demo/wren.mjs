#!/usr/bin/env node
/**
 * scripts/demo/wren.mjs — wren's on-camera act. Reads like a coding
 * agent's real loop, but talks straight to the seeded demo server
 * over MCP: pings → claim (after mason's lease expired) → work note →
 * done. Every beat prints with a small pause so the recording breathes.
 *
 * Usage: node scripts/demo/wren.mjs
 */
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sdkRequire = createRequire(join(REPO, "packages/skill/package.json"));
const { Client } = sdkRequire("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = sdkRequire(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const CAPTURE_DIR = process.env.POLYMER_CAPTURE_DIR ?? "/tmp/opencode";
const state = JSON.parse(
  readFileSync(`${CAPTURE_DIR}/demo-state.json`, "utf8"),
);

// The camera act uses wren's enrollment token from the seed state —
// she's a real enrolled agent, heartbeating from the seed's first loop.
const WREN_TOKEN = state.tokens?.wren;
if (!WREN_TOKEN) {
  console.error("no wren token in state — seed must persist enrollment tokens");
  process.exit(1);
}

const pause = (s = 1.5) => sleep(s * 1000);

const client = new Client({ name: "wren", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(state.mcp_url), {
    requestInit: { headers: { Authorization: `Bearer ${WREN_TOKEN}` } },
  }),
);

function say(step, text) {
  console.log(`\n\x1b[1m[step]\x1b[0m ${step}`);
  console.log(`  ${text}`);
}

say("wake", "wren checks in — heartbeat first, then the inbox");
await client.callTool({ name: "send_heartbeat", arguments: {} });
await pause();

say("inbox", "checking unread pings…");
const pings = await client.callTool({
  name: "get_unread_pings",
  arguments: {},
});
const items = pings.structuredContent?.pings ?? [];
const fromMason = items.find((p) => (p.content ?? "").includes("@wren"));
console.log(
  JSON.stringify(
    { unread: items.length, first: fromMason?.content ?? null },
    null,
    2,
  ),
);
await pause();

say("board", "pull the list — claim, don't wait to be assigned");
const tasks = await client.callTool({ name: "get_tasks", arguments: {} });
const open = (tasks.structuredContent?.tasks ?? []).filter(
  (t) => t.status !== "done",
);
console.log(open.map((t) => `${t.status.padEnd(12)} ${t.title}`).join("\n"));
await pause();

const target = fromMason
  ? open.find((t) => t.task_id === fromMason.task_id)
  : open.find((t) => t.title.includes("rate-limit"));
if (!target) {
  console.error(
    "no claimable target — the act assumed mason's lease expired by now",
  );
  process.exit(2);
}
say("claim", `claim ${target.title} — atomically, with a fenced lease`);
// Mason may still hold the lease; the polite agent polls, never forces.
let claimed = false;
for (let attempt = 1; attempt <= 20; attempt += 1) {
  const attemptClaim = await client.callTool({
    name: "claim_task",
    arguments: { task_id: target.task_id },
  });
  if (!attemptClaim.isError) {
    claimed = true;
    break;
  }
  const err = attemptClaim.structuredContent?.error ?? "";
  console.log(
    `  lease still live (${err || "error"}) — polling, never forcing…`,
  );
  await sleep(3000);
}
if (!claimed) {
  console.error("lease never lapsed within the polling window");
  process.exit(2);
}
await pause();

say(
  "work",
  "the handoff from mason carries the context; post progress, then completion",
);
await client.callTool({
  name: "post_comment",
  arguments: {
    task_id: target.task_id,
    content:
      "Back from mason's handoff: plumbed retry_after through the JSON layer; headers land on every 429 (Retry-After, X-RateLimit-Limit/Remaining/Reset).",
  },
});
await pause();

say(
  "complete",
  "done is terminal — the lease clears, wren's cost lands on the Tokens page",
);
const detail = await client.callTool({
  name: "get_task_detail",
  arguments: { task_id: target.task_id },
});
await client.callTool({
  name: "update_task_status",
  arguments: {
    task_id: target.task_id,
    status: "done",
    lease_generation: detail.structuredContent.lease_generation,
    expected_version: detail.structuredContent.version,
  },
});
await pause();

say("verify", "ping says connected; roster shows the fleet");
const ping = await client.callTool({ name: "ping", arguments: {} });
const roster = await client.callTool({
  name: "get_agent_roster",
  arguments: {},
});
console.log(
  JSON.stringify(
    {
      ping_ok: ping.structuredContent?.ok === true,
      roster:
        roster.structuredContent?.agents?.length ??
        roster.structuredContent?.count ??
        "n/a",
    },
    null,
    2,
  ),
);

say(
  "telemetry",
  "one OTLP span per LLM call — this is what joins wren's cost to the task",
);
const nowNs = `${Date.now() * 1_000_000}`;
const spanBatch = {
  resourceSpans: [
    {
      resource: {
        attributes: [{ key: "service.name", value: { stringValue: "wren" } }],
      },
      scopeSpans: [
        {
          scope: { name: "demo-agent", version: "0.1.0" },
          spans: [
            {
              traceId: "5b8efff798038105d7f39f9d3b8d3f52",
              spanId: "eeee161d8261bbf7",
              name: `${target.title} — model call`,
              kind: 1,
              startTimeUnixNano: nowNs,
              endTimeUnixNano: `${BigInt(nowNs) + 2_000_000_000n}`,
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
                  value: { intValue: "2841" },
                },
                {
                  key: "gen_ai.usage.output_tokens",
                  value: { intValue: "742" },
                },
                {
                  key: "gen_ai.usage.cost_micro_usd",
                  value: { intValue: "9142" },
                },
                {
                  key: "polymer.task_id",
                  value: { stringValue: target.task_id },
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const otelRes = await fetch(`${state.server_url}/otel/v1/traces`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${WREN_TOKEN}`,
  },
  body: JSON.stringify(spanBatch),
});
console.log(`  OTLP export -> ${otelRes.status} (200: validated + queued)`);
await pause();

await client.close();
console.log("\n\x1b[32mact complete — the board did the bookkeeping\x1b[0m");
