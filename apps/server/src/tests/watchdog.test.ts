import { describe, expect, it } from "vitest";
import { EventBus } from "../http/events.js";
import { getAgentById } from "../identity/agents.js";
import { getTask } from "../tasks/store.js";
import { createLeaseNotifier, runLivenessSweep } from "../identity/watchdog.js";
import { listen } from "../http/server.js";
import {
  lapseLeases,
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

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

function taskOwnership(
  db: NonNullable<Awaited<ReturnType<typeof listen>>["db"]>,
  taskId: string,
) {
  return db
    .prepare(
      `SELECT coordinator, lease_expires_at, lease_generation
         FROM tasks WHERE task_id = ?`,
    )
    .get(taskId);
}

function fullSnapshot(
  db: NonNullable<Awaited<ReturnType<typeof listen>>["db"]>,
) {
  const out: Record<string, unknown[]> = {};
  for (const table of [
    "agents",
    "credentials",
    "tasks",
    "task_assignments",
    "comments",
    "mentions",
    "audit_log",
    "otel_spans",
    "usage_records",
    "telemetry_counters",
  ]) {
    out[table] = db
      .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
      .all() as unknown[];
  }
  return out;
}

describe("heartbeat watchdog (component 29)", () => {
  it("send_heartbeat drives idle/working over real MCP; disabled is rejected", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-watchdog-"),
      livenessSweepIntervalMs: 0,
      leaseNotifierIntervalMs: 0,
    });
    try {
      const [a] = await registerAgentsOn(app, ["watchdog-a"]);
      await withAuthedClients(app, [a.token], async ([c]) => {
        const beat = (await c.callTool({
          name: "send_heartbeat",
          arguments: {},
        })) as { structuredContent: Record<string, unknown> };
        expect(beat.structuredContent["success"]).toBe(true);
        const timestamp = beat.structuredContent["timestamp"] as string;
        expect(getAgentById(app.db!, a.agentId)?.status).toBe("idle");
        expect(getAgentById(app.db!, a.agentId)?.last_seen).toBe(timestamp);

        // Coordinating a live lease reads as working…
        await c.callTool({
          name: "create_task",
          arguments: { title: "leased" },
        });
        await c.callTool({ name: "send_heartbeat", arguments: {} });
        expect(getAgentById(app.db!, a.agentId)?.status).toBe("working");

        // …until the lease lapses, when the same call reads idle.
        lapseLeases(app);
        await c.callTool({ name: "send_heartbeat", arguments: {} });
        expect(getAgentById(app.db!, a.agentId)?.status).toBe("idle");

        // Disabled agents are rejected with no write of any kind.
        const seen = getAgentById(app.db!, a.agentId)?.last_seen;
        app
          .db!.prepare(
            "UPDATE agents SET status = 'disabled' WHERE agent_id = ?",
          )
          .run(a.agentId);
        const denied = (await c.callTool({
          name: "send_heartbeat",
          arguments: {},
        })) as unknown as { isError?: boolean };
        expect(denied.isError).toBe(true);
        expect(JSON.stringify(denied)).toContain("unauthorized");
        expect(getAgentById(app.db!, a.agentId)?.status).toBe("disabled");
        expect(getAgentById(app.db!, a.agentId)?.last_seen).toBe(seen);
      });
    } finally {
      await app.close();
    }
  });

  it("stale agents disconnect without touching ownership; claims still work", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-watchdog-"),
      livenessSweepIntervalMs: 0,
      leaseNotifierIntervalMs: 0,
    });
    try {
      const [a, b, c, d] = await registerAgentsOn(app, [
        "watchdog-a",
        "watchdog-b",
        "watchdog-c",
        "watchdog-d",
      ]);
      const taskId = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "owned" },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
      // The lease expires; the owner goes quiet; a third agent is
      // disabled while quiet; a fourth sits exactly on the edge.
      lapseLeases(app);
      const now = Date.now();
      app
        .db!.prepare("UPDATE agents SET last_seen = ? WHERE agent_id = ?")
        .run("2000-01-01T00:00:00.000Z", a.agentId);
      app
        .db!.prepare(
          "UPDATE agents SET status = 'disabled', last_seen = ? WHERE agent_id = ?",
        )
        .run("2000-01-01T00:00:00.000Z", c.agentId);
      app
        .db!.prepare("UPDATE agents SET last_seen = ? WHERE agent_id = ?")
        .run(new Date(now - 300_000).toISOString(), d.agentId);
      const ownedBefore = taskOwnership(app.db!, taskId);

      const sweep = runLivenessSweep(app.db!, app.events, { nowMs: now });
      expect(sweep.marked).toEqual([a.agentId]);
      expect(sweep.truncated).toBe(false);
      expect(getAgentById(app.db!, a.agentId)?.status).toBe("disconnected");
      // Fresh, disabled, and exactly-at-timeout agents are untouched.
      expect(getAgentById(app.db!, b.agentId)?.status).not.toBe("disconnected");
      expect(getAgentById(app.db!, c.agentId)?.status).toBe("disabled");
      // Exactly at the timeout is not stale (strictly-greater rule).
      expect(getAgentById(app.db!, d.agentId)?.status).not.toBe("disconnected");

      // The watchdog wrote no ownership: byte-identical task row…
      expect(taskOwnership(app.db!, taskId)).toEqual(ownedBefore);
      // …while concurrency safety never needed it: a fresh claim lands.
      await withAuthedClients(app, [b.token], async ([cb]) => {
        const claim = (await cb.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        })) as { structuredContent: Record<string, unknown> };
        expect(claim.structuredContent["coordinator"]).toBe(b.agentId);
      });

      // Job 1 announced itself on the bus and nothing else did.
      const announced = app.events
        .replay("0")
        .filter(
          (e) =>
            e.type === "agent.status_changed" &&
            e.data["status"] === "disconnected",
        );
      expect(announced.map((e) => e.data["agent_id"])).toEqual([a.agentId]);
    } finally {
      await app.close();
    }
  });

  it("the lease notifier emits expiries and writes nothing", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-watchdog-"),
      livenessSweepIntervalMs: 0,
      leaseNotifierIntervalMs: 0,
    });
    try {
      const [a] = await registerAgentsOn(app, ["watchdog-a"]);
      const taskId = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "lapsing" },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
      lapseLeases(app);
      const before = fullSnapshot(app.db!);
      const bus = new EventBus();
      const notifier = createLeaseNotifier(bus);

      const first = notifier.check(app.db!, Date.now());
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        task_id: taskId,
        coordinator: a.agentId,
      });
      expect(fullSnapshot(app.db!)).toEqual(before);

      // Tracked: the same expiry never re-emits…
      expect(notifier.check(app.db!, Date.now() + 1000)).toEqual([]);
      // …but a newer expiry does.
      const taskId2 = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "lapsing-2" },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
      app
        .db!.prepare("UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?")
        .run(new Date(Date.now() + 2000).toISOString(), taskId2);
      const third = notifier.check(app.db!, Date.now() + 3000);
      expect(third.map((l) => l.task_id)).toEqual([taskId2]);

      const emitted = bus
        .replay("0")
        .filter((e) => e.type === "task.lease_expired");
      expect(emitted).toHaveLength(2);
      expect(emitted[0].data).toMatchObject({
        task_id: taskId,
        coordinator: a.agentId,
      });
      expect(getTask(app.db!, taskId)?.coordinator).toBe(a.agentId);
    } finally {
      await app.close();
    }
  });

  it("both timers run unassisted", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-watchdog-"),
      livenessSweepIntervalMs: 25,
      leaseNotifierIntervalMs: 25,
    });
    try {
      const [a] = await registerAgentsOn(app, ["watchdog-a"]);
      const taskId = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "timed" },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
      lapseLeases(app);
      app
        .db!.prepare("UPDATE agents SET last_seen = ? WHERE agent_id = ?")
        .run("2000-01-01T00:00:00.000Z", a.agentId);
      await waitFor(
        () => getAgentById(app.db!, a.agentId)?.status === "disconnected",
      );
      await waitFor(() =>
        app.events
          .replay("0")
          .some(
            (e) =>
              e.type === "task.lease_expired" && e.data["task_id"] === taskId,
          ),
      );
    } finally {
      await app.close();
    }
  });
});
