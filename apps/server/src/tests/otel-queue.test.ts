import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import { closeDatabase, openDatabase } from "../database/db.js";
import { TelemetryQueue } from "../telemetry/queue.js";
import type { ValidatedSpan } from "../telemetry/otlp.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

const SERVER_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "dist",
  "index.js",
);

function span(traceId: string, spanId: string, name = "s"): ValidatedSpan {
  return {
    traceId,
    spanId,
    parentSpanId: null,
    name,
    kind: 0,
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    statusCode: 0,
    statusMessage: null,
    attributes: [],
    resourceAttributes: [],
    scope: { name: "", version: "" },
  };
}

const T = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const S = (n: number) => `bbbbbbbbbbbbbb${n.toString(16).padStart(2, "0")}`;

function seedAgent(db: ReturnType<typeof openDatabase>): string {
  const id = `agent-${Math.random().toString(36).slice(2)}`;
  db.prepare("INSERT INTO agents (agent_id, name, role) VALUES (?, ?, ?)").run(
    id,
    `name-${id}`,
    "coder",
  );
  return id;
}

function rowCount(
  db: ReturnType<typeof openDatabase>,
  table = "otel_spans",
): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
    n: number;
  };
  return row.n;
}

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

describe("telemetry queue (component 23)", () => {
  it("unit: enqueue then flush writes rows in order", () => {
    const db = openDatabase(tempDbPath("polymer-queue-"));
    try {
      const agentId = seedAgent(db);
      const queue = new TelemetryQueue(db, { maxBatches: 10, flushMs: 60000 });
      try {
        expect(queue.depth()).toBe(0);
        expect(
          queue.enqueue({
            agentId,
            spans: [span(T, S(1))],
            receivedAt: "2026-01-01T00:00:00.000Z",
          }),
        ).toBe(true);
        expect(
          queue.enqueue({
            agentId,
            spans: [span(T, S(2))],
            receivedAt: "2026-01-01T00:00:01.000Z",
          }),
        ).toBe(true);
        expect(queue.depth()).toBe(2);
        // Nothing is committed before the flush.
        expect(rowCount(db)).toBe(0);
        expect(queue.flush()).toBe(2);
        expect(queue.depth()).toBe(0);
        expect(rowCount(db)).toBe(2);
        const rows = db
          .prepare(
            "SELECT span_id, trace_id, agent_id, name FROM otel_spans ORDER BY rowid ASC",
          )
          .all() as Array<Record<string, unknown>>;
        expect(rows.map((r) => r["span_id"])).toEqual([S(1), S(2)]);
        expect(rows[0]["trace_id"]).toBe(T);
        expect(rows[0]["agent_id"]).toBe(agentId);
        expect(rows[0]["name"]).toBe("s");
        // Flushing an empty queue is a no-op.
        expect(queue.flush()).toBe(0);
      } finally {
        queue.stop();
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("unit: a full queue rejects; flush reopens it", () => {
    const db = openDatabase(tempDbPath("polymer-queue-"));
    try {
      const agentId = seedAgent(db);
      const queue = new TelemetryQueue(db, { maxBatches: 1, flushMs: 60000 });
      try {
        expect(
          queue.enqueue({ agentId, spans: [span(T, S(1))], receivedAt: "t" }),
        ).toBe(true);
        expect(
          queue.enqueue({ agentId, spans: [span(T, S(2))], receivedAt: "t" }),
        ).toBe(false);
        expect(queue.depth()).toBe(1);
        expect(queue.flush()).toBe(1);
        expect(
          queue.enqueue({ agentId, spans: [span(T, S(2))], receivedAt: "t" }),
        ).toBe(true);
      } finally {
        queue.stop();
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("unit: retried spans are idempotent", () => {
    const db = openDatabase(tempDbPath("polymer-queue-"));
    try {
      const agentId = seedAgent(db);
      const queue = new TelemetryQueue(db, { maxBatches: 10, flushMs: 60000 });
      try {
        const batch = {
          agentId,
          spans: [span(T, S(1))],
          receivedAt: "t",
        };
        expect(queue.enqueue(batch)).toBe(true);
        expect(queue.enqueue(batch)).toBe(true);
        // Two batches accepted, one row survives the retry.
        expect(queue.flush()).toBe(1);
        expect(rowCount(db)).toBe(1);
      } finally {
        queue.stop();
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("unit: a flush spanning the 500-row bound writes everything", () => {
    const db = openDatabase(tempDbPath("polymer-queue-"));
    try {
      const agentId = seedAgent(db);
      const queue = new TelemetryQueue(db, { maxBatches: 10, flushMs: 60000 });
      try {
        const hex = (n: number) => n.toString(16).padStart(16, "0");
        const spansA = Array.from({ length: 400 }, (_, i) => span(T, hex(i)));
        const spansB = Array.from({ length: 400 }, (_, i) =>
          span(T, hex(400 + i)),
        );
        expect(queue.enqueue({ agentId, spans: spansA, receivedAt: "t" })).toBe(
          true,
        );
        expect(queue.enqueue({ agentId, spans: spansB, receivedAt: "t" })).toBe(
          true,
        );
        // 800 rows across the 500-row transaction bound: 500 + 300.
        expect(queue.flush()).toBe(800);
        expect(rowCount(db)).toBe(800);
        expect(queue.depth()).toBe(0);
      } finally {
        queue.stop();
      }
    } finally {
      closeDatabase(db);
    }
  });

  it("unit: the timer flushes without a manual call", async () => {
    const db = openDatabase(tempDbPath("polymer-queue-"));
    try {
      const agentId = seedAgent(db);
      const queue = new TelemetryQueue(db, { maxBatches: 10, flushMs: 20 });
      try {
        queue.start();
        expect(
          queue.enqueue({ agentId, spans: [span(T, S(1))], receivedAt: "t" }),
        ).toBe(true);
        await waitFor(() => rowCount(db) === 1);
        expect(queue.depth()).toBe(0);
      } finally {
        queue.stop();
      }
    } finally {
      closeDatabase(db);
    }
  });

  it(
    "ingested batches land durably with agent attribution",
    { timeout: 60000 },
    async () => {
      const app = await listen("127.0.0.1", 0, {
        databasePath: tempDbPath("polymer-queue-"),
        telemetryBatchFlushMs: 25,
      });
      try {
        const [agent] = await registerAgentsOn(app, ["otel-agent"]);
        const bodies: string[] = [];
        for (let b = 0; b < 3; b += 1) {
          const spans = [0, 1].map((i) => ({
            traceId: T,
            spanId: S(b * 2 + i),
            name: `batch-${b}-span-${i}`,
          }));
          bodies.push(
            JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
          );
        }
        for (const body of bodies) {
          const res = await fetch(`${app.url}/otel/v1/traces`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${agent.token}`,
              "content-type": "application/json",
            },
            body,
          });
          expect(res.status).toBe(200);
        }
        await waitFor(() => rowCount(app.db!) === 6);
        const rows = app
          .db!.prepare("SELECT agent_id FROM otel_spans")
          .all() as Array<{ agent_id: string }>;
        expect(new Set(rows.map((r) => r.agent_id))).toEqual(
          new Set([agent.agentId]),
        );
      } finally {
        await app.close();
      }
    },
  );

  it("a filled queue answers 429 with retry_after and commits nothing early", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-queue-"),
      telemetryQueueMaxBatches: 2,
      telemetryBatchFlushMs: 60000,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const post = (n: number) =>
        fetch(`${app.url}/otel/v1/traces`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${agent.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            resourceSpans: [
              { scopeSpans: [{ spans: [{ traceId: T, spanId: S(n) }] }] },
            ],
          }),
        });
      expect((await post(1)).status).toBe(200);
      expect((await post(2)).status).toBe(200);
      const full = await post(3);
      expect(full.status).toBe(429);
      expect(await full.json()).toEqual({
        error: "rate_limit_exceeded",
        retry_after: 60,
      });
      // Accepted means queued, never committed: nothing is durable.
      expect(rowCount(app.db!)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it(
    "coordination stays responsive while the backlog drains",
    { timeout: 60000 },
    async () => {
      const app = await listen("127.0.0.1", 0, {
        databasePath: tempDbPath("polymer-queue-"),
        telemetryBatchFlushMs: 20,
      });
      try {
        const [agent] = await registerAgentsOn(app, ["otel-agent"]);
        for (let b = 0; b < 5; b += 1) {
          const spans = Array.from({ length: 10 }, (_, i) => ({
            traceId: T,
            spanId: S(b * 10 + i),
            name: `bulk-${b}-${i}`,
          }));
          const res = await fetch(`${app.url}/otel/v1/traces`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${agent.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              resourceSpans: [{ scopeSpans: [{ spans }] }],
            }),
          });
          expect(res.status).toBe(200);
        }
        // Task coordination interleaves with the draining writer and
        // succeeds: telemetry never starves it.
        await withAuthedClients(app, [agent.token], async ([client]) => {
          const created = (await client.callTool({
            name: "create_task",
            arguments: { title: "During drain" },
          })) as unknown as { isError?: boolean };
          expect(created.isError ?? false).toBe(false);
        });
        await waitFor(() => rowCount(app.db!) === 50);
      } finally {
        await app.close();
      }
    },
  );

  it(
    "a clean shutdown commits what a crash would lose",
    { timeout: 60000 },
    async () => {
      const dbPath = tempDbPath("polymer-queue-");
      const app = await listen("127.0.0.1", 0, {
        databasePath: dbPath,
        telemetryBatchFlushMs: 60000,
      });
      try {
        const [agent] = await registerAgentsOn(app, ["otel-agent"]);
        const res = await fetch(`${app.url}/otel/v1/traces`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${agent.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            resourceSpans: [
              { scopeSpans: [{ spans: [{ traceId: T, spanId: S(1) }] }] },
            ],
          }),
        });
        expect(res.status).toBe(200);
        // Nothing committed yet — the timer would take a minute.
        expect(rowCount(app.db!)).toBe(0);
        // Clean shutdown drains first: the batch survives.
        await app.close();
      } finally {
        // close() twice is safe; guard the double-close path anyway.
        await app.close().catch(() => undefined);
      }
      const reopened = await listen("127.0.0.1", 0, { databasePath: dbPath });
      try {
        expect(rowCount(reopened.db!)).toBe(1);
      } finally {
        await reopened.close();
      }
    },
  );

  it(
    "a crash loses queued-but-uncommitted telemetry (documents at-most-once)",
    { timeout: 60000 },
    async () => {
      const dbPath = tempDbPath("polymer-queue-");
      const setup = await listen("127.0.0.1", 0, { databasePath: dbPath });
      let token = "";
      try {
        const [agent] = await registerAgentsOn(setup, ["otel-agent"]);
        token = agent.token;
      } finally {
        await setup.close();
      }

      // Fresh process, default 1000ms flush window: enqueue, confirm
      // the 200, then SIGKILL long before any flush can run.
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
        const res = await fetch(`http://127.0.0.1:${port}/otel/v1/traces`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            resourceSpans: [
              { scopeSpans: [{ spans: [{ traceId: T, spanId: S(1) }] }] },
            ],
          }),
        });
        expect(res.status).toBe(200);
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

      // Restart on the same file: the accepted-but-unflushed batch is
      // absent. This is the documented durability contract, not a bug.
      const reopened = await listen("127.0.0.1", 0, { databasePath: dbPath });
      try {
        expect(rowCount(reopened.db!)).toBe(0);
      } finally {
        await reopened.close();
      }
    },
  );
});
