import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { mintCredential } from "./credentials.js";
import { getTask, listTaskAssignees } from "./tasks.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-assign-")), "test.db");
}

type App = Awaited<ReturnType<typeof listen>>;

interface AgentSession {
  agentId: string;
  token: string;
}

/** Register agents over real MCP (bootstrap surface). */
async function registerAgentsOn(
  app: App,
  names: string[],
): Promise<AgentSession[]> {
  const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
  await bootstrap.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  try {
    const sessions: AgentSession[] = [];
    for (const name of names) {
      const { credential, secret } = mintCredential(app.db!, {
        type: "init",
      });
      const reg = (await bootstrap.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: credential.credential_id,
          init_token: secret,
          name,
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      sessions.push({
        agentId: reg.structuredContent["agent_id"] as string,
        token: reg.structuredContent["session_token"] as string,
      });
    }
    return sessions;
  } finally {
    await bootstrap.close();
  }
}

async function withAuthedClients<T>(
  app: App,
  tokens: string[],
  fn: (clients: Client[]) => Promise<T>,
): Promise<T> {
  const clients: Client[] = [];
  for (const token of tokens) {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
  }
  try {
    return await fn(clients);
  } finally {
    for (const client of clients) {
      await client.close();
    }
  }
}

interface CallOutcome {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callTask(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as unknown as CallOutcome;
  return result;
}

/** A creates a task over real MCP and returns its fixture row. */
async function createTaskAs(
  app: App,
  a: AgentSession,
  title: string,
): Promise<Record<string, unknown>> {
  return withAuthedClients(app, [a.token], async ([client]) => {
    const created = await callTask(client, "create_task", { title });
    expect(created.isError).toBeFalsy();
    return created.structuredContent!;
  });
}

/** Lapse the lazy-expiry lease. */
function lapseLeases(app: App): void {
  app
    .db!.prepare(
      "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z'",
    )
    .run();
}

describe("task assignment tools (component 15)", () => {
  it("multiple agents attach to a task without corrupting coordinator ownership", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b, c] = await registerAgentsOn(app, [
        "agent-a",
        "agent-b",
        "agent-c",
      ]);
      const created = await createTaskAs(app, a, "Crew task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const first = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
        expect(first.isError).toBeFalsy();
        const out = first.structuredContent!;
        // Exact contract shape.
        expect(Object.keys(out).sort()).toEqual([
          "assigned_to",
          "lease_generation",
          "task_id",
          "updated_at",
          "version",
        ]);
        expect(out["assigned_to"]).toEqual([b.agentId]);
        expect(out["version"]).toBe(2);
        // Assignment is not an ownership-epoch change.
        expect(out["lease_generation"]).toBe(1);

        const second = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [c.agentId],
          lease_generation: 1,
          expected_version: 2,
        });
        expect(second.structuredContent!["assigned_to"]).toEqual([
          b.agentId,
          c.agentId,
        ]);
        expect(second.structuredContent!["version"]).toBe(3);
        expect(second.structuredContent!["lease_generation"]).toBe(1);
      });

      // Ownership untouched: coordinator is still A, aligned with the
      // row in SQLite.
      const stored = getTask(app.db!, taskId)!;
      expect(stored.coordinator).toBe(a.agentId);
      expect(stored.version).toBe(3);
      expect(stored.lease_generation).toBe(1);

      // Assignees read the task like any fleet member, and the
      // assigned_to filter resolves by persisted rows.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const mine = await callTask(client, "get_tasks", {
          assigned_to: b.agentId,
        });
        const tasks = mine.structuredContent!["tasks"] as Array<
          Record<string, unknown>
        >;
        expect(tasks.map((t) => t["task_id"])).toContain(taskId);
      });
    } finally {
      await app.close();
    }
  });

  it("a duplicate assignment is already_assigned and mutates nothing", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await createTaskAs(app, a, "Dup task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const first = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
        expect(first.isError).toBeFalsy();

        const duplicate = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 2,
        });
        expect(duplicate.isError).toBe(true);
        expect(JSON.stringify(duplicate)).toContain("already_assigned");
      });

      expect(getTask(app.db!, taskId)!.version).toBe(2);
      expect(listTaskAssignees(app.db!, taskId)).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("a nonexistent target agent is agent_not_found with no partial rows", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const created = await createTaskAs(app, a, "Ghost task");
      const taskId = created["task_id"] as string;
      const before = getTask(app.db!, taskId)!;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const out = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [randomUUID()],
          lease_generation: 1,
          expected_version: 1,
        });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("agent_not_found");
        expect(JSON.stringify(out)).not.toMatch(/SQLITE|no such table/i);
      });

      // All-or-nothing: no version bump, no rows.
      expect(getTask(app.db!, taskId)!.version).toBe(before.version);
      expect(listTaskAssignees(app.db!, taskId)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("only the coordinator can assign, even with valid fence values", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await createTaskAs(app, a, "A's task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [b.token], async ([client]) => {
        const out = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("unauthorized");
      });
      expect(getTask(app.db!, taskId)!.version).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("transfer_coordinator hands off ownership with a new generation, and the old coordinator can no longer write", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b, d] = await registerAgentsOn(app, [
        "agent-a",
        "agent-b",
        "agent-d",
      ]);
      const created = await createTaskAs(app, a, "Handoff");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
        const transfer = await callTask(client, "transfer_coordinator", {
          task_id: taskId,
          new_coordinator_id: b.agentId,
          lease_generation: 1,
          expected_version: 2,
        });
        expect(transfer.isError).toBeFalsy();
        const out = transfer.structuredContent!;
        expect(Object.keys(out).sort()).toEqual([
          "coordinator",
          "lease_expires_at",
          "lease_generation",
          "task_id",
          "updated_at",
          "version",
        ]);
        expect(out["coordinator"]).toBe(b.agentId);
        expect(out["version"]).toBe(3);
        // A new fencing epoch: the old coordinator's in-flight writes
        // reject on generation mismatch.
        expect(out["lease_generation"]).toBe(2);
        expect(
          new Date(out["lease_expires_at"] as string).getTime(),
        ).toBeGreaterThan(Date.now());
      });

      // A's in-flight write attempt after the handoff: rejected, state
      // unchanged.
      await withAuthedClients(app, [a.token], async ([client]) => {
        const rejected = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [d.agentId],
          lease_generation: 1,
          expected_version: 3,
        });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain("unauthorized");
      });
      expect(getTask(app.db!, taskId)!.version).toBe(3);

      // The new coordinator mutates through the same authorization
      // model.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const out = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [d.agentId],
          lease_generation: 2,
          expected_version: 3,
        });
        expect(out.isError).toBeFalsy();
        expect(out.structuredContent!["version"]).toBe(4);
      });
      expect(getTask(app.db!, taskId)!.coordinator).toBe(b.agentId);
    } finally {
      await app.close();
    }
  });

  it("transfer to an unassigned registered agent is not_assigned", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, c] = await registerAgentsOn(app, ["agent-a", "agent-c"]);
      const created = await createTaskAs(app, a, "Loyal task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const out = await callTask(client, "transfer_coordinator", {
          task_id: taskId,
          new_coordinator_id: c.agentId,
          lease_generation: 1,
          expected_version: 1,
        });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("not_assigned");
      });
      expect(getTask(app.db!, taskId)!.coordinator).toBe(a.agentId);
    } finally {
      await app.close();
    }
  });

  it("transfer to an unknown agent is agent_not_found", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const created = await createTaskAs(app, a, "Nowhere task");
      await withAuthedClients(app, [a.token], async ([client]) => {
        const out = await callTask(client, "transfer_coordinator", {
          task_id: created["task_id"] as string,
          new_coordinator_id: randomUUID(),
          lease_generation: 1,
          expected_version: 1,
        });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("agent_not_found");
      });
    } finally {
      await app.close();
    }
  });

  it("transfer never recovers an expired lease: the successor reclaims first", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b, c] = await registerAgentsOn(app, [
        "agent-a",
        "agent-b",
        "agent-c",
      ]);
      const created = await createTaskAs(app, a, "Stalled task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
      });

      // The coordinator's lease lapses: even the coordinator cannot
      // transfer without a live lease.
      lapseLeases(app);
      await withAuthedClients(app, [a.token], async ([client]) => {
        const out = await callTask(client, "transfer_coordinator", {
          task_id: taskId,
          new_coordinator_id: b.agentId,
          lease_generation: 1,
          expected_version: 2,
        });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("unauthorized");
      });

      // The successor reclaims via claim_task — never via transfer.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const claimed = await callTask(client, "claim_task", {
          task_id: taskId,
        });
        expect(claimed.isError).toBeFalsy();
        expect(claimed.structuredContent!["coordinator"]).toBe(b.agentId);
      });

      // Ownership recovered, the lease is live again: B attaches C
      // (assign bumps version only), then transfers ownership over.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const assigned = await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [c.agentId],
          lease_generation: 2,
          expected_version: 3,
        });
        expect(assigned.isError, JSON.stringify(assigned)).toBeFalsy();
        expect(assigned.structuredContent!["version"]).toBe(4);

        const out = await callTask(client, "transfer_coordinator", {
          task_id: taskId,
          new_coordinator_id: c.agentId,
          lease_generation: 2,
          expected_version: 4,
        });
        expect(out.isError, JSON.stringify(out)).toBeFalsy();
        expect(out.structuredContent!["coordinator"]).toBe(c.agentId);
        expect(out.structuredContent!["version"]).toBe(5);
        expect(out.structuredContent!["lease_generation"]).toBe(3);
      });
    } finally {
      await app.close();
    }
  });

  it("request_unassignment deletes only the caller's row and touches nothing else", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b, c] = await registerAgentsOn(app, [
        "agent-a",
        "agent-b",
        "agent-c",
      ]);
      const created = await createTaskAs(app, a, "Relay task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        await callTask(client, "assign_task", {
          task_id: taskId,
          agent_ids: [b.agentId, c.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
      });
      const afterAssign = getTask(app.db!, taskId)!;

      await withAuthedClients(app, [b.token], async ([client]) => {
        const out = await callTask(client, "request_unassignment", {
          task_id: taskId,
          reason: "context moved to the tracker",
        });
        expect(out.isError).toBeFalsy();
        const unassign = out.structuredContent!;
        expect(Object.keys(unassign).sort()).toEqual(["message", "success"]);
        expect(unassign["success"]).toBe(true);
        expect(unassign["message"]).toContain("tracker");
      });

      // Only B's row is gone; coordinator, lease, status, version —
      // untouched, exactly as the contract requires.
      expect(getTask(app.db!, taskId)).toEqual(afterAssign);
      const remaining = listTaskAssignees(app.db!, taskId).map(
        (x) => x.agent_id,
      );
      expect(remaining).toEqual([c.agentId]);
    } finally {
      await app.close();
    }
  });

  it("request_unassignment without a row is not_assigned; unknown task is task_not_found", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const created = await createTaskAs(app, a, "Empty task");
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        // The coordinator holds no assignment row by default.
        const unassigned = await callTask(client, "request_unassignment", {
          task_id: taskId,
        });
        expect(unassigned.isError).toBe(true);
        expect(JSON.stringify(unassigned)).toContain("not_assigned");

        const unknown = await callTask(client, "request_unassignment", {
          task_id: randomUUID(),
        });
        expect(unknown.isError).toBe(true);
        expect(JSON.stringify(unknown)).toContain("task_not_found");
      });
    } finally {
      await app.close();
    }
  });
});
