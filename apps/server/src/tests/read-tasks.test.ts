import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { listen } from "../http/server.js";
import { mintCredential } from "../identity/credentials.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-read-tasks-")), "test.db");
}

interface AgentSession {
  agentId: string;
  token: string;
}

// Each client gets its own server, all sharing one SQLite file (the
// fleet view). Servers accept many sessions now (mcp.test.ts); this
// isolation is a fixture choice, not a transport limit.
async function withClient<T>(
  dbPath: string,
  token: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`${app.url}${MCP_PATH}`),
      token
        ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } }
        : undefined,
    ),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
    await app.close();
  }
}

/** Register agents over real MCP (unauthenticated bootstrap surface). */
async function registerAgents(
  dbPath: string,
  names: string[],
): Promise<AgentSession[]> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
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
    await app.close();
  }
}

async function callRead(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  expect(result.isError).toBeFalsy();
  return result.structuredContent!;
}

function tasksOf(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return body["tasks"] as Array<Record<string, unknown>>;
}

describe("read task MCP tools (component 12)", () => {
  it("an agent discovers fleet state through MCP: filters work and identity comes from the server", async () => {
    const dbPath = tempDbPath();
    const [agentA, agentB] = await registerAgents(dbPath, [
      "agent-a",
      "agent-b",
    ]);

    // Several tasks from multiple agents, created over real MCP.
    await withClient(dbPath, agentA.token, async (client) => {
      await client.callTool({
        name: "create_task",
        arguments: { title: "A-1", description: "first" },
      });
      await client.callTool({
        name: "create_task",
        arguments: { title: "A-2" },
      });
    });
    await withClient(dbPath, agentB.token, async (client) => {
      await client.callTool({
        name: "create_task",
        arguments: { title: "B-1" },
      });
    });

    // Fixture seeds: A-1 is claimed by its creator (to_do -> in_progress
    // is claim-only: version+1, generation+1, live lease) and B-1 is
    // assigned by its coordinator (assign bumps version only). Mirrors
    // components 13/18 effects so the seeded rows stay spec-reachable.
    const seedApp = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const now = new Date().toISOString();
      seedApp
        .db!.prepare(
          `UPDATE tasks
              SET status = 'in_progress',
                  version = version + 1,
                  lease_generation = lease_generation + 1,
                  lease_expires_at = ?,
                  updated_at = ?
            WHERE title = 'A-1'`,
        )
        .run(new Date(Date.now() + 3_600_000).toISOString(), now);
      seedApp
        .db!.prepare(
          `INSERT INTO task_assignments (task_id, agent_id)
           SELECT task_id, ? FROM tasks WHERE title = 'B-1'`,
        )
        .run(agentA.agentId);
      seedApp
        .db!.prepare(
          "UPDATE tasks SET version = version + 1, updated_at = ? WHERE title = 'B-1'",
        )
        .run(now);
    } finally {
      await seedApp.close();
    }

    await withClient(dbPath, agentB.token, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["get_tasks", "get_task_detail"]),
      );

      // Fleet-wide read rule: B sees every task, including A's.
      const all = await callRead(client, "get_tasks", {});
      const allTasks = tasksOf(all);
      expect(allTasks.map((t) => t["title"]).sort()).toEqual([
        "A-1",
        "A-2",
        "B-1",
      ]);

      // Identity comes from the server, not the caller: results carry
      // the registered agent ids, and the created_by filter only filters.
      for (const task of allTasks) {
        expect([agentA.agentId, agentB.agentId]).toContain(task["created_by"]);
        expect(task["coordinator"]).toBe(task["created_by"]);
      }
      expect(
        allTasks.find((t) => t["title"] === "B-1")!["assigned_to"],
      ).toEqual([agentA.agentId]);

      // status filter
      const inProgress = await callRead(client, "get_tasks", {
        status: "in_progress",
      });
      expect(tasksOf(inProgress).map((t) => t["title"])).toEqual(["A-1"]);
      const done = await callRead(client, "get_tasks", { status: "done" });
      expect(tasksOf(done)).toEqual([]);

      // created_by filter (server identity as the filter value)
      const byA = await callRead(client, "get_tasks", {
        created_by: agentA.agentId,
      });
      expect(
        tasksOf(byA)
          .map((t) => t["title"])
          .sort(),
      ).toEqual(["A-1", "A-2"]);
      expect(
        tasksOf(byA).every((t) => t["created_by"] === agentA.agentId),
      ).toBe(true);

      // assigned_to filter
      const assignedToA = await callRead(client, "get_tasks", {
        assigned_to: agentA.agentId,
      });
      const assigned = tasksOf(assignedToA);
      expect(assigned.map((t) => t["title"])).toEqual(["B-1"]);
      expect(assigned[0]["assigned_to"]).toEqual([agentA.agentId]);

      // limit filter
      const limited = await callRead(client, "get_tasks", { limit: 1 });
      expect(tasksOf(limited)).toHaveLength(1);
    });
  });

  it("get_task_detail returns complete detail across agents", async () => {
    const dbPath = tempDbPath();
    const [agentA, agentB] = await registerAgents(dbPath, [
      "agent-a",
      "agent-b",
    ]);

    let created: Record<string, unknown>;
    await withClient(dbPath, agentA.token, async (client) => {
      created = await callRead(client, "create_task", {
        title: "Detail task",
        description: "full detail",
        trace_parent: "00-abc-def-01",
      });
    });

    // Seed an assignment (coordinator-assigned: bumps version only,
    // generation unchanged) so assigned_to is observable in detail.
    const seedApp = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      seedApp
        .db!.prepare(
          "INSERT INTO task_assignments (task_id, agent_id) VALUES (?, ?)",
        )
        .run(created!["task_id"] as string, agentB.agentId);
      seedApp
        .db!.prepare(
          "UPDATE tasks SET version = version + 1, updated_at = ? WHERE task_id = ?",
        )
        .run(new Date().toISOString(), created!["task_id"] as string);
    } finally {
      await seedApp.close();
    }

    // Agent B reads A's task: fleet-wide read rule.
    await withClient(dbPath, agentB.token, async (client) => {
      const detail = await callRead(client, "get_task_detail", {
        task_id: created!["task_id"],
      });
      expect(detail).toMatchObject({
        task_id: created!["task_id"],
        title: "Detail task",
        description: "full detail",
        status: "to_do",
        version: 2,
        created_by: agentA.agentId,
        coordinator: agentA.agentId,
        lease_generation: 1,
        trace_parent: "00-abc-def-01",
        assigned_to: [agentB.agentId],
        comments: [],
        has_more: false,
      });
      expect(typeof detail["lease_expires_at"]).toBe("string");
      expect(typeof detail["created_at"]).toBe("string");
      expect(typeof detail["updated_at"]).toBe("string");
    });
  });

  it("a nonexistent task returns task_not_found", async () => {
    const dbPath = tempDbPath();
    const [agentA] = await registerAgents(dbPath, ["agent-a"]);
    await withClient(dbPath, agentA.token, async (client) => {
      const result = (await client.callTool({
        name: "get_task_detail",
        arguments: { task_id: randomUUID() },
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toContain("task_not_found");
      // The not-found McpError passes through unwrapped: exactly one
      // SDK prefix, never a doubled one.
      expect(text).not.toContain("MCP error -32600: MCP error");
    });
  });

  it("driver failures surface as database_error without leaking SQL", async () => {
    const dbPath = tempDbPath();
    const [agentA] = await registerAgents(dbPath, ["agent-a"]);

    // One task so both reads reach the broken assignee lookup.
    let taskId = "";
    await withClient(dbPath, agentA.token, async (client) => {
      const created = await callRead(client, "create_task", {
        title: "Doomed task",
      });
      taskId = created["task_id"] as string;
    });

    // Break the shared schema between requests: assignment reads now
    // throw a better-sqlite3 SqliteError.
    const breakApp = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      breakApp.db!.prepare("DROP TABLE task_assignments").run();
    } finally {
      await breakApp.close();
    }

    await withClient(dbPath, agentA.token, async (client) => {
      for (const [name, args] of [
        ["get_tasks", {}],
        ["get_task_detail", { task_id: taskId }],
      ] as const) {
        const result = (await client.callTool({ name, arguments: args })) as {
          isError?: boolean;
        };
        expect(result.isError).toBe(true);
        const text = JSON.stringify(result);
        expect(text).toContain("database_error");
        expect(text).not.toMatch(/SQLITE|no such table/i);
      }
    });
  });

  it("invalid read filters are rejected", async () => {
    const dbPath = tempDbPath();
    const [agentA] = await registerAgents(dbPath, ["agent-a"]);
    await withClient(dbPath, agentA.token, async (client) => {
      const badStatus = (await client.callTool({
        name: "get_tasks",
        arguments: { status: "bogus" },
      })) as { isError?: boolean };
      expect(badStatus.isError).toBe(true);
      expect(JSON.stringify(badStatus)).toContain("invalid_status");

      // Out-of-range limits are schema violations: the SDK reports
      // JSON-RPC -32602 before the handler runs (the service check
      // stays as defense for direct callers).
      for (const limit of [0, 501]) {
        const badLimit = (await client.callTool({
          name: "get_tasks",
          arguments: { limit },
        })) as { isError?: boolean };
        expect(badLimit.isError).toBe(true);
        expect(JSON.stringify(badLimit)).toContain("-32602");
      }
    });
  });

  it("unauthenticated reads are rejected at the HTTP layer", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      for (const name of ["get_tasks", "get_task_detail"]) {
        const res = await fetch(`${app.url}${MCP_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: { task_id: "x" } },
          }),
        });
        expect(res.status).toBe(401);
        await res.body?.cancel();
      }
    } finally {
      await app.close();
    }
  });
});
