import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { mintCredential } from "./credentials.js";
import { getTask } from "./tasks.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-lease-guard-")), "test.db");
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

/** Component-14 probe: a no-op write through the lease guard. */
async function probe(
  client: Client,
  taskId: string,
  leaseGeneration: number,
  expectedVersion: number,
): Promise<{ isError?: boolean; structuredContent?: Record<string, unknown> }> {
  const result = (await client.callTool({
    name: "__test_lease_write",
    arguments: {
      task_id: taskId,
      lease_generation: leaseGeneration,
      expected_version: expectedVersion,
    },
  })) as unknown as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  return result;
}

/** Lapse the lazy-expiry lease: the coordinator becomes read-only. */
function lapseLeases(app: App): void {
  app
    .db!.prepare(
      "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z'",
    )
    .run();
}

describe("coordinator lease guard (component 14)", () => {
  it("__test_lease_write is present only when testSeams is enabled", async () => {
    const dbPath = tempDbPath();
    let token = "";

    const plain = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const [a] = await registerAgentsOn(plain, ["agent-a"]);
      token = a.token;
      await withAuthedClients(plain, [token], async ([client]) => {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).not.toContain(
          "__test_lease_write",
        );
      });
    } finally {
      await plain.close();
    }

    const seams = await listen("127.0.0.1", 0, {
      databasePath: dbPath,
      testSeams: true,
    });
    try {
      await withAuthedClients(seams, [token], async ([client]) => {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain("__test_lease_write");
      });
    } finally {
      await seams.close();
    }
  });

  it("an old coordinator can never mutate after another agent acquired the lease", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
      testSeams: true,
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const result = (await client.callTool({
            name: "create_task",
            arguments: { title: "Fenced" },
          })) as { structuredContent: Record<string, unknown> };
          return result.structuredContent;
        },
      );
      const taskId = created["task_id"] as string;
      expect(created["version"]).toBe(1);
      expect(created["lease_generation"]).toBe(1);

      // The lease lapses: A still holds `coordinator` on the row but
      // no live lease, so A must be read-only on this task.
      lapseLeases(app);
      await withAuthedClients(app, [a.token], async ([client]) => {
        const rejected = await probe(client, taskId, 1, 1);
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain("unauthorized");
        expect(getTask(app.db!, taskId)!.version).toBe(1);
      });

      // B acquires generation 2 through the real claim path.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const claimed = (await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        })) as { structuredContent: Record<string, unknown> };
        expect(claimed.structuredContent["lease_generation"]).toBe(2);
        expect(claimed.structuredContent["version"]).toBe(2);
      });

      // A's next write attempt is rejected and mutates nothing.
      await withAuthedClients(app, [a.token], async ([client]) => {
        const rejected = await probe(client, taskId, 1, 2);
        expect(rejected.isError).toBe(true);
        expect(getTask(app.db!, taskId)!.version).toBe(2);
      });

      // The new owner writes through the guard.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const allowed = await probe(client, taskId, 2, 2);
        expect(allowed.isError).toBeFalsy();
        expect(allowed.structuredContent!["version"]).toBe(3);
      });
      expect(getTask(app.db!, taskId)!.version).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("a stale lease_generation or expected_version is version_mismatch with no state change", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
      testSeams: true,
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const result = (await client.callTool({
            name: "create_task",
            arguments: { title: "Guarded" },
          })) as { structuredContent: Record<string, unknown> };
          return result.structuredContent;
        },
      );
      const taskId = created["task_id"] as string;
      const before = getTask(app.db!, taskId)!;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const staleGeneration = await probe(client, taskId, 2, 1);
        expect(staleGeneration.isError).toBe(true);
        expect(JSON.stringify(staleGeneration)).toContain("version_mismatch");

        const staleVersion = await probe(client, taskId, 1, 99);
        expect(staleVersion.isError).toBe(true);
        expect(JSON.stringify(staleVersion)).toContain("version_mismatch");
      });

      // Neither rejected write moved the task state.
      const stored = getTask(app.db!, taskId)!;
      expect(stored.version).toBe(1);
      expect(stored.updated_at).toBe(before.updated_at);
    } finally {
      await app.close();
    }
  });

  it("a non-coordinator caller is unauthorized", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
      testSeams: true,
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const result = (await client.callTool({
            name: "create_task",
            arguments: { title: "Owned by A" },
          })) as { structuredContent: Record<string, unknown> };
          return result.structuredContent;
        },
      );
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [b.token], async ([client]) => {
        const rejected = await probe(client, taskId, 1, 1);
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain("unauthorized");
      });
      expect(getTask(app.db!, taskId)!.version).toBe(1);
    } finally {
      await app.close();
    }
  });
});
