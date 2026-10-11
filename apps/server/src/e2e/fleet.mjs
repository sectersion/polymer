#!/usr/bin/env node
/**
 * Component 31: deterministic end-to-end fleet scenario (`pnpm e2e:fleet`).
 *
 * Boots a fresh production server (dist build) on a temporary database
 * and drives the whole scenario over real transports only: admin REST
 * (login + OTP mint), the component-30 installer for every agent,
 * real MCP calls, real OTLP ingestion via the OTel SDK exporter, and
 * the web-facing REST reads. No mocks on any transport boundary; the
 * only harness privileges are spawning processes and reading the
 * first-run master secret off the server's own stderr (the operator
 * flow). Any step failing kills the server and exits non-zero.
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SERVER_ENTRY = join(REPO, "apps/server/dist/index.js");
const INSTALLER = join(REPO, "packages/skill/install.mjs");

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

let step = "boot";
function pass(message) {
  console.log(`e2e:fleet [PASS] ${step}: ${message}`);
}
function fail(message) {
  console.error(`e2e:fleet [FAIL] ${step}: ${message}`);
  throw new Error(message);
}
function expectEqual(actual, expected, what) {
  if (actual !== expected) {
    fail(
      `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

function runInstaller(server, dir, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      [INSTALLER, "--server", server, "--dir", dir, ...args],
      { timeout: 60000 },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (status) => {
      if (status === 0) resolvePromise();
      else reject(new Error(`polymer-install exited ${status}: ${stderr}`));
    });
  });
}

async function mcpCall(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result?.isError) fail(`tool ${name} errored: ${JSON.stringify(result)}`);
  return result.structuredContent;
}

async function authedClient(server, token) {
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${server}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function main() {
  const workdir = mkdtempSync(join(tmpdir(), "polymer-e2e-"));
  const dbPath = join(workdir, "e2e.db");
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;

  step = "boot";
  const server = spawn(
    process.execPath,
    [SERVER_ENTRY, "--port", String(port)],
    {
      env: { ...process.env, POLYMER_DATABASE_PATH: dbPath },
    },
  );
  let master = null;
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = stderr.match(
      /polymer master credential \(save it now; it is not shown again\): (\S+)/,
    );
    if (match) master = match[1];
  });
  server.stdout.resume();
  let shuttingDown = false;
  server.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(
        `e2e:fleet server exited early: code=${code} signal=${signal}`,
      );
      console.error(`e2e:fleet server stderr tail: ${stderr.slice(-2000)}`);
    }
  });
  const kill = () =>
    new Promise((done) => {
      if (server.exitCode !== null || server.signalCode !== null) {
        done();
        return;
      }
      server.once("exit", () => done());
      server.kill("SIGTERM");
      setTimeout(() => {
        try {
          server.kill("SIGKILL");
        } catch {
          // Already exited; the exit listener resolves kill().
        }
      }, 5000).unref?.();
    });
  process.on("SIGINT", () => kill().finally(() => process.exit(130)));

  try {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        const res = await fetch(`${base}/health`);
        if (res.status === 200) break;
      } catch {
        // Not listening yet; retry until the deadline.
      }
      if (Date.now() > deadline) fail("server never became healthy");
      await sleep(100);
    }
    if (!master) fail("first-run master credential never appeared on stderr");
    pass(`fresh server healthy at ${base}`);

    step = "admin-onboards-agents";
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ master_credential: master }),
    });
    expectEqual(loginRes.status, 200, "admin login");
    const login = await loginRes.json();
    const cookie = loginRes.headers
      .getSetCookie?.()
      .map((c) => c.split(";")[0])
      .join("; ");
    if (!cookie?.includes("__Host-polymer_admin="))
      fail("login set no admin cookie");
    const adminHeaders = {
      cookie,
      "x-csrf-token": login.csrf_token,
      "content-type": "application/json",
    };
    async function mintOtp() {
      const res = await fetch(`${base}/api/tokens/init`, {
        method: "POST",
        headers: adminHeaders,
        body: "{}",
      });
      expectEqual(res.status, 200, "mint init OTP");
      return res.json();
    }
    const otpA = await mintOtp();
    const otpB = await mintOtp();
    pass("admin logged in, minted two OTPs");

    step = "installer-configures-agents";
    const dirA = join(workdir, "agent-a");
    const dirB = join(workdir, "agent-b");
    await runInstaller(base, dirA, [
      "--name",
      "e2e-a",
      "--init-token-id",
      otpA.init_token_id,
      "--init-token",
      otpA.init_token,
    ]);
    await runInstaller(base, dirB, [
      "--name",
      "e2e-b",
      "--init-token-id",
      otpB.init_token_id,
      "--init-token",
      otpB.init_token,
    ]);
    const { readFileSync } = await import("node:fs");
    const rcA = JSON.parse(readFileSync(join(dirA, ".polymrc"), "utf8"));
    const rcB = JSON.parse(readFileSync(join(dirB, ".polymrc"), "utf8"));
    pass("both agents enrolled through polymer-install");

    step = "agent-a-works-task";
    const clientA = await authedClient(base, rcA.session_token);
    const clientB = await authedClient(base, rcB.session_token);
    try {
      const task = await mcpCall(clientA, "create_task", {
        title: "e2e fleet task",
        trace_parent: `00-${TRACE_ID}-00f067aa0ba902b7-01`,
      });
      const taskId = task.task_id;
      const claimed = await mcpCall(clientA, "claim_task", {
        task_id: taskId,
        lease_duration_seconds: 1,
      });
      expectEqual(claimed.status, "in_progress", "claim moves to in_progress");
      await mcpCall(clientA, "post_comment", {
        task_id: taskId,
        content: "@e2e-b your turn next",
      });
      const beat = await mcpCall(clientA, "send_heartbeat", {});
      expectEqual(beat.success, true, "heartbeat acknowledged");
      pass(`task ${taskId} created, claimed, commented`);

      step = "otel-ingestion";
      const exporter = new OTLPTraceExporter({
        url: `${base}/otel/v1/traces`,
        headers: { authorization: `Bearer ${rcA.session_token}` },
        concurrencyLimit: 1,
      });
      const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({ "service.name": "e2e-fleet" }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      const tracer = provider.getTracer("e2e", "1.0.0");
      const span = tracer.startSpan("e2e-inference", {
        attributes: {
          "gen_ai.request.model": "e2e-model",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 50,
          "gen_ai.usage.cost_micro_usd": 2500,
          "polymer.task_id": taskId,
        },
      });
      span.end();
      await provider.forceFlush();
      await provider.shutdown();
      pass("OTLP span exported through the real SDK");

      step = "agent-b-takes-over";
      await mcpCall(clientB, "send_heartbeat", {});
      const pings = await mcpCall(clientB, "get_unread_pings", {});
      if (!Array.isArray(pings.pings) || pings.pings.length !== 1) {
        fail(`expected one ping, got ${JSON.stringify(pings)}`);
      }
      expectEqual(pings.pings[0].task_id, taskId, "ping points at the task");
      await sleep(1500); // A's 1s lease lapses: transition, not force.
      const claimedB = await mcpCall(clientB, "claim_task", {
        task_id: taskId,
      });
      expectEqual(
        claimedB.coordinator,
        rcB.agent_id,
        "B coordinates after transition",
      );
      const detail = await mcpCall(clientB, "get_task_detail", {
        task_id: taskId,
      });
      const done = await mcpCall(clientB, "update_task_status", {
        task_id: taskId,
        status: "done",
        lease_generation: detail.lease_generation,
        expected_version: detail.version,
      });
      expectEqual(done.status, "done", "task completes");
      pass("B read the ping, claimed after expiry, completed the task");

      step = "web-api-reads";
      const rest = (path) => fetch(`${base}${path}`, { headers: { cookie } });
      const tasks = await (await rest("/api/tasks")).json();
      const seen = tasks.tasks.find((t) => t.task_id === taskId);
      expectEqual(seen?.status, "done", "REST shows the completed task");
      const summary = await (await rest("/api/telemetry/summary")).json();
      if (summary.total_tokens_used !== 150) {
        fail(`expected 150 tokens, got ${JSON.stringify(summary)}`);
      }
      expectEqual(
        summary.total_cost_micro_usd,
        2500,
        "REST shows reported cost",
      );
      const agents = await (await rest("/api/telemetry/agents")).json();
      expectEqual(agents.agents.length, 2, "both agents in telemetry");
      const timeline = await (
        await rest("/api/telemetry/timeline?limit=10")
      ).json();
      // The SDK mints trace ids; the task link arrives via the
      // polymer.task_id claim (component 26's contract), not by
      // reusing the task's trace_parent.
      const scenarioEvent = timeline.events.find((e) => e.task_id === taskId);
      if (!scenarioEvent || !/^[0-9a-f]{32}$/.test(scenarioEvent.trace_id)) {
        fail(`scenario trace missing: ${JSON.stringify(timeline)}`);
      }
      const costs = await (
        await rest("/api/telemetry/costs?granularity=daily")
      ).json();
      if (!costs.time_series.some((b) => b.cost_micro_usd === 2500)) {
        fail(`scenario cost missing: ${JSON.stringify(costs)}`);
      }
      pass("web API reflects tasks, telemetry, timeline, and costs");
    } finally {
      await clientA.close().catch(() => {});
      await clientB.close().catch(() => {});
    }
  } finally {
    shuttingDown = true;
    await kill();
  }
  console.log("e2e:fleet SUCCESS");
}

try {
  await main();
} catch (err) {
  console.error(`e2e:fleet FAILED: ${err.message}`);
  process.exit(1);
}
