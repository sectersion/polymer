#!/usr/bin/env node
/**
 * scripts/demo/act.mjs — the on-camera agent beat, fixed schedule.
 * Wren claims the rate-limit task, posts a handoff comment, completes
 * it, and emits one OTLP span. Every action is prompt — nothing waits
 * on camera. The camera (capture.mjs) polls REST for the flips.
 *
 * Schedule (seconds after start):
 *   +4   claim  -> board flips TO DO -> IN PROGRESS
 *   +10  comment -> detail thread gains the handoff
 *   +30  complete + span -> board flips -> DONE, cost row lands
 *
 * Usage: node scripts/demo/act.mjs
 */
import { readFileSync } from "node:fs";
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
const S = JSON.parse(readFileSync(`${CAPDIR}/demo-state.json`, "utf8"));
const out = (...a) => console.error("[act]", ...a);

const T0 = Date.now();
async function at(second, label, fn) {
  const wait = T0 + second * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  out(`t+${second}s ${label}`);
  await fn();
}

async function checked(label, promise) {
  const res = await promise;
  if (res?.isError) {
    throw new Error(
      `${label} failed: ${JSON.stringify(res.structuredContent)}`,
    );
  }
  return res;
}

const client = new Client({ name: "wren", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(S.mcp_url), {
    requestInit: { headers: { Authorization: `Bearer ${S.tokens.wren}` } },
  }),
);

const taskId = S.tasks.rate_limit_headers;

await at(4, "claim", () =>
  checked(
    "claim",
    client.callTool({ name: "claim_task", arguments: { task_id: taskId } }),
  ),
);

await at(10, "comment", () =>
  checked(
    "comment",
    client.callTool({
      name: "post_comment",
      arguments: {
        task_id: taskId,
        content:
          "Limiter shape is in; headers need retry_after plumbed through the JSON layer. @mason — transport retry is your street, take it from here.",
      },
    }),
  ),
);

await at(30, "complete", async () => {
  const detail = await checked(
    "detail",
    client.callTool({
      name: "get_task_detail",
      arguments: { task_id: taskId },
    }),
  );
  await checked(
    "complete",
    client.callTool({
      name: "update_task_status",
      arguments: {
        task_id: taskId,
        status: "done",
        lease_generation: detail.structuredContent.lease_generation,
        expected_version: detail.structuredContent.version,
      },
    }),
  );
  const nowNs = `${Date.now() * 1_000_000}`;
  await fetch(`${S.server_url}/otel/v1/traces`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${S.tokens.wren}`,
    },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "wren" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "demo-agent", version: "0.1.0" },
              spans: [
                {
                  traceId: "5b8efff798038105d7f39f9d3b8d3f52",
                  spanId: "eeee161d8261bbf7",
                  name: "Add rate-limit headers to /api/* — model call",
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
});

await client.close();
out("act complete");
