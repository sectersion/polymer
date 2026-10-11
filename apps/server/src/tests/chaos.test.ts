import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { closeDatabase, openDatabase } from "../database/db.js";
import { createAgent } from "../identity/agents.js";
import { bootstrapMaster } from "../identity/credentials.js";
import { listen } from "../http/server.js";
import {
  lapseLeases,
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
  type App,
} from "./test-support.js";

/**
 * Component 32: failure/chaos tests. Every intentionally induced
 * failure below produces a known, documented result — never undefined
 * behavior, never a bare 500. Full case catalog:
 *
 * 1.  two agents claiming simultaneously → exactly one wins with
 *     `in_progress`, the loser sees `task_already_claimed`
 *     (claim-tasks.test.ts, component 13 — permanent regression).
 * 2.  stale task updates → `version_mismatch` / generation rejection,
 *     re-read-and-retry recovers (lease-guard + task-status tests).
 * 3.  expired credentials → `invalid_token` / `token_expired`, never
 *     anonymous access (session-auth + credentials tests).
 * 4.  replayed init tokens → `token_already_used`, single use
 *     (registration tests).
 * 5.  replayed reconnect credentials → `reconnect_already_used` plus
 *     a security-event log line (refresh tests).
 * 6.  telemetry queue overflow → 429 + `retry_after`, nothing
 *     committed early (otel-queue tests).
 * 7.  malformed telemetry → 400 `invalid_request`, good spans in the
 *     same posture unaffected (otel tests).
 * 8.  database contention past the busy budget → `database_error`
 *     (503 on REST / InternalError on MCP), full recovery the moment
 *     the lock releases (this file).
 * 9.  SIGKILL during telemetry ingestion → accepted-but-unflushed
 *     batches absent after restart: at-most-once (otel-queue crash
 *     test). Coordination restart below is this file.
 * 10. SIGKILL mid-lease → lease row byte-identical after restart, live
 *     lease still fences new claims, old sessions still authenticate
 *     (this file).
 * 11. agent disappearance during a lease → `disconnected` liveness,
 *     ownership untouched, later claims succeed (watchdog tests).
 * 12. disabling a 1000+ subtree mid telemetry-flood → completes with
 *     every agent disabled and coordination pings unaffected
 *     (this file).
 * 13. parent disable mid-lease → heartbeat `unauthorized`, spawn
 *     `parent_disabled`, every task/comment mutation `unauthorized`,
 *     while the released lease stays immediately claimable by an
 *     outsider (this file; status-gating closed the loop left open
 *     at component 32).
 * 14. WebSocket drop mid-stream → resume-by-cursor replays exactly the
 *     missed events, then live (events tests).
 */

const SERVER_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "index.js",
);

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no port assigned"));
        }
      });
    });
  });
}

function cookieOf(setCookie: string): string {
  const pair = setCookie.split(";")[0].trim();
  const eq = pair.indexOf("=");
  return eq === -1 ? pair : pair.slice(eq + 1).trim();
}

async function adminSession(
  app: App,
  master: string,
): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${app.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ master_credential: master }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  const raw = res.headers.get("set-cookie") ?? "";
  return { cookie: cookieOf(raw), csrf: body["csrf_token"] as string };
}

describe("failure/chaos (component 32)", () => {
  it(
    "database contention past the busy budget fails clean and recovers",
    { timeout: 60000 },
    async () => {
      const dbPath = tempDbPath("polymer-chaos-");
      const app = await listen("127.0.0.1", 0, {
        databasePath: dbPath,
        telemetryBatchFlushMs: 60000,
        telemetryRetentionIntervalMs: 0,
        livenessSweepIntervalMs: 0,
        leaseNotifierIntervalMs: 0,
      });
      const locker = openDatabase(dbPath);
      try {
        const [a, b] = await registerAgentsOn(app, ["chaos-a", "chaos-b"]);
        const taskId = await withAuthedClients(app, [a.token], async ([ca]) => {
          const t = (await ca.callTool({
            name: "create_task",
            arguments: { title: "contended" },
          })) as { structuredContent: Record<string, unknown> };
          return t.structuredContent["task_id"] as string;
        });

        // A second connection parks a RESERVED lock: no writer,
        // coordination or telemetry, can commit until it releases.
        // (The creator's initial lease is lapsed first so the claim
        // below reaches the write path instead of the lease guard.)
        lapseLeases(app);
        locker.exec("BEGIN IMMEDIATE");
        locker
          .prepare("UPDATE agents SET last_seen = last_seen WHERE agent_id = ?")
          .run(a.agentId);
        const blocked = await withAuthedClients(
          app,
          [b.token],
          async ([cb]) => {
            const outcome = (await cb.callTool({
              name: "claim_task",
              arguments: { task_id: taskId },
            })) as unknown as { isError?: boolean };
            return outcome;
          },
        );
        expect(blocked.isError).toBe(true);
        expect(JSON.stringify(blocked)).toContain("database_error");

        // The moment the lock releases, the same write lands — and the
        // server itself never wedged (health answers throughout).
        locker.exec("ROLLBACK");
        await withAuthedClients(app, [b.token], async ([cb]) => {
          const claim = (await cb.callTool({
            name: "claim_task",
            arguments: { task_id: taskId },
          })) as { structuredContent: Record<string, unknown> };
          expect(claim.structuredContent["coordinator"]).toBe(b.agentId);
        });
        expect((await fetch(`${app.url}/health`)).status).toBe(200);
      } finally {
        try {
          locker.exec("ROLLBACK");
        } catch {
          // Already rolled back on the happy path.
        }
        closeDatabase(locker);
        await app.close();
      }
    },
  );

  it(
    "SIGKILL mid-lease preserves coordination across restart",
    { timeout: 60000 },
    async () => {
      const dbPath = tempDbPath("polymer-chaos-");
      const setup = await listen("127.0.0.1", 0, { databasePath: dbPath });
      let ownerToken = "";
      let ownerId = "";
      let taskId = "";
      let beforeRow: unknown = null;
      try {
        const [owner] = await registerAgentsOn(setup, ["chaos-owner"]);
        ownerToken = owner.token;
        ownerId = owner.agentId;
        taskId = await withAuthedClients(
          setup,
          [owner.token],
          async ([client]) => {
            const t = (await client.callTool({
              name: "create_task",
              arguments: { title: "survives restart" },
            })) as { structuredContent: Record<string, unknown> };
            const id = t.structuredContent["task_id"] as string;
            await client.callTool({
              name: "claim_task",
              arguments: { task_id: id },
            });
            return id;
          },
        );
        beforeRow = setup
          .db!.prepare(
            "SELECT coordinator, lease_expires_at, lease_generation, status FROM tasks WHERE task_id = ?",
          )
          .get(taskId);
      } finally {
        await setup.close();
      }

      const port = await freePort();
      const child = spawn(process.execPath, [SERVER_DIST], {
        env: {
          ...process.env,
          POLYMER_PORT: String(port),
          POLYMER_DATABASE_PATH: dbPath,
        },
        stdio: "ignore",
      });
      try {
        await waitFor(async () => {
          try {
            const res = await fetch(`http://127.0.0.1:${port}/health`);
            return res.status === 200;
          } catch {
            return false;
          }
        }, 15000);
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => {
          child.on("exit", () => resolve());
          setTimeout(resolve, 5000);
        });
      } finally {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already dead: the expected path.
        }
      }

      const reopened = await listen("127.0.0.1", 0, { databasePath: dbPath });
      try {
        // The lease row survived the kill byte-identical and still
        // fences: a stranger's claim is rejected, the owner's session
        // still authenticates.
        const row = reopened
          .db!.prepare(
            "SELECT coordinator, lease_expires_at, lease_generation, status FROM tasks WHERE task_id = ?",
          )
          .get(taskId) as Record<string, unknown>;
        expect(row).toEqual(beforeRow);
        expect(row["coordinator"]).toBe(ownerId);
        const [stranger] = await registerAgentsOn(reopened, ["chaos-stranger"]);
        const rejected = await withAuthedClients(
          reopened,
          [stranger.token],
          async ([client]) => {
            const outcome = (await client.callTool({
              name: "claim_task",
              arguments: { task_id: taskId },
            })) as unknown as { isError?: boolean };
            return outcome;
          },
        );
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain("task_already_claimed");
        const ping = await withAuthedClients(
          reopened,
          [ownerToken],
          async ([client]) => {
            const result = (await client.callTool({
              name: "ping",
              arguments: {},
            })) as { structuredContent: Record<string, unknown> };
            return result.structuredContent;
          },
        );
        expect(ping["ok"]).toBe(true);
      } finally {
        await reopened.close();
      }
    },
  );

  it(
    "parent disable mid-lease gates the subtree; heartbeat and spawn fail clean",
    { timeout: 60000 },
    async () => {
      const app = await listen("127.0.0.1", 0, {
        databasePath: tempDbPath("polymer-chaos-"),
      });
      try {
        const master = bootstrapMaster(app.db!)!;
        const { cookie, csrf } = await adminSession(app, master);
        const [parent] = await registerAgentsOn(app, ["chaos-parent"]);
        const spawned = await withAuthedClients(
          app,
          [parent.token],
          async ([client]) => {
            const sub = (await client.callTool({
              name: "register_subagent",
              arguments: { name: "chaos-child", role: "coder" },
            })) as { structuredContent: Record<string, unknown> };
            const created = (await client.callTool({
              name: "create_task",
              arguments: { title: "mid-lease work" },
            })) as { structuredContent: Record<string, unknown> };
            const taskId = created.structuredContent["task_id"] as string;
            await client.callTool({
              name: "claim_task",
              arguments: { task_id: taskId },
            });
            return {
              childToken: sub.structuredContent["session_token"] as string,
              taskId,
            };
          },
        );

        const res = await fetch(
          `${app.url}/api/agents/${parent.agentId}/disable`,
          {
            method: "POST",
            headers: {
              cookie: `__Host-polymer_admin=${cookie}`,
              "x-csrf-token": csrf,
              "content-type": "application/json",
            },
            body: "{}",
          },
        );
        expect(res.status).toBe(200);
        expect(
          ((await res.json()) as Record<string, unknown>)["complete"],
        ).toBe(true);

        // Enforcement lives at the status gate: heartbeat and spawn
        // reject, and (since the follow-up slice) so does every
        // task/comment mutation — while the released lease stays
        // immediately claimable by an outsider (lease-governed).
        const childDenied = await withAuthedClients(
          app,
          [spawned.childToken],
          async ([client]) => {
            const beat = (await client.callTool({
              name: "send_heartbeat",
              arguments: {},
            })) as unknown as { isError?: boolean };
            const spawn = (await client.callTool({
              name: "register_subagent",
              arguments: { name: "grandchild", role: "coder" },
            })) as unknown as { isError?: boolean };
            const claim = (await client.callTool({
              name: "claim_task",
              arguments: { task_id: spawned.taskId },
            })) as unknown as { isError?: boolean };
            return { beat, spawn, claim };
          },
        );
        expect(childDenied.beat.isError).toBe(true);
        expect(JSON.stringify(childDenied.beat)).toContain("unauthorized");
        expect(childDenied.spawn.isError).toBe(true);
        expect(JSON.stringify(childDenied.spawn)).toContain("parent_disabled");
        expect(childDenied.claim.isError).toBe(true);
        expect(JSON.stringify(childDenied.claim)).toContain("unauthorized");
        const [outsider] = await registerAgentsOn(app, ["chaos-outsider"]);
        await withAuthedClients(app, [outsider.token], async ([client]) => {
          const claim = (await client.callTool({
            name: "claim_task",
            arguments: { task_id: spawned.taskId },
          })) as { structuredContent: Record<string, unknown> };
          expect(claim.structuredContent["coordinator"]).toBe(outsider.agentId);
        });
      } finally {
        await app.close();
      }
    },
  );

  it(
    "disabling a 1000+ subtree mid telemetry-flood keeps coordination responsive",
    { timeout: 180000 },
    async () => {
      const app = await listen("127.0.0.1", 0, {
        databasePath: tempDbPath("polymer-chaos-"),
        telemetryBatchFlushMs: 25,
      });
      try {
        const master = bootstrapMaster(app.db!)!;
        const { cookie, csrf } = await adminSession(app, master);
        const samplerNames = ["chaos-s0", "chaos-s1", "chaos-s2", "chaos-s3"];
        const [parent, flooder, ...samplerAgents] = await registerAgentsOn(
          app,
          ["chaos-parent", "chaos-flood", ...samplerNames],
        );
        // Setup, not transport under test: 1000 descendants by direct
        // service call (one row each, no sessions involved).
        const seed = app.db!.transaction(() => {
          for (let i = 0; i < 1000; i += 1) {
            createAgent(app.db!, {
              name: `flood-child-${i}`,
              role: "coder",
              parentAgentId: parent.agentId,
            });
          }
        });
        seed();

        // Telemetry flood: unique spans force real writer work (no
        // dedup shortcuts), 429s counted as correct backpressure.
        // Paced so the flood spans a multi-second window the sampler
        // and the disable both land inside (a pure burst would finish
        // before either engaged).
        let accepted = 0;
        let rejected429 = 0;
        let spanSeq = 0;
        const floodBody = () => {
          const spans = [0, 1].map((i) => {
            spanSeq += 1;
            return {
              traceId: "a".repeat(32),
              spanId: spanSeq.toString(16).padStart(16, "0"),
              name: `flood-${i}`,
            };
          });
          return JSON.stringify({
            resourceSpans: [{ scopeSpans: [{ spans }] }],
          });
        };
        const flood = (async () => {
          for (let i = 0; i < 1500; i += 1) {
            const res = await fetch(`${app.url}/otel/v1/traces`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${flooder.token}`,
                "content-type": "application/json",
              },
              body: floodBody(),
            });
            if (res.status === 200) accepted += 1;
            else if (res.status === 429) rejected429 += 1;
            else throw new Error(`flood answered ${res.status}`);
            await new Promise((r) => setTimeout(r, 4));
          }
        })();

        // Coordination sampler: four agents on their own rate
        // budgets (~60 pings/min each, under the 100/min cap),
        // rotating every 250ms for ~4 samples/sec through the chaos.
        const samplerTokens = samplerAgents.map((s) => s.token);
        const samplers: Client[] = [];
        for (const token of samplerTokens) {
          const client = new Client({ name: "sampler", version: "0.0.0" });
          await client.connect(
            new StreamableHTTPClientTransport(
              new URL(`${app.url}${MCP_PATH}`),
              {
                requestInit: { headers: { Authorization: `Bearer ${token}` } },
              },
            ),
          );
          samplers.push(client);
        }
        const rtts: number[] = [];
        let sampling = true;
        let pingErrors = 0;
        const sample = (async () => {
          let i = 0;
          while (sampling) {
            const client = samplers[i % samplers.length];
            const start = Date.now();
            try {
              const out = (await client.callTool({
                name: "ping",
                arguments: {},
              })) as unknown as {
                isError?: boolean;
              };
              if (out.isError) pingErrors += 1;
              else rtts.push(Date.now() - start);
            } catch {
              pingErrors += 1;
            }
            i += 1;
            await new Promise((r) => setTimeout(r, 250));
          }
        })();
        try {
          // Let the flood build pressure, then disable mid-flood.
          await new Promise((r) => setTimeout(r, 100));
          const disableRes = await fetch(
            `${app.url}/api/agents/${parent.agentId}/disable`,
            {
              method: "POST",
              headers: {
                cookie: `__Host-polymer_admin=${cookie}`,
                "x-csrf-token": csrf,
                "content-type": "application/json",
              },
              body: "{}",
            },
          );
          expect(disableRes.status).toBe(200);
          const disableBody = (await disableRes.json()) as Record<
            string,
            unknown
          >;
          expect(disableBody["complete"]).toBe(true);
          expect(disableBody["disabled_count"]).toBe(1001);
          await flood;
        } finally {
          sampling = false;
          await sample;
          for (const client of samplers) await client.close();
        }

        const disabled = (
          app
            .db!.prepare(
              "SELECT COUNT(*) AS n FROM agents WHERE status = 'disabled'",
            )
            .get() as { n: number }
        ).n;
        expect(disabled).toBe(1001);
        expect(pingErrors).toBe(0);
        expect(rtts.length).toBeGreaterThan(10);
        const sorted = [...rtts].sort((x, y) => x - y);
        const p95 =
          sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
        expect(p95).toBeLessThan(2000);
        expect(accepted + rejected429).toBe(1500);
      } finally {
        await app.close();
      }
    },
  );
});
