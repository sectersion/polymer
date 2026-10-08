import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getTask } from "../tasks/index.js";
import { MCP_PATH } from "../mcp/index.js";
import { listen } from "../http/server.js";
import { mintCredential } from "../identity/credentials.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-create-task-")), "test.db");
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

describe("create_task MCP tool (component 11)", () => {
  it("agent A creates a durable task as creator and coordinator", async () => {
    const dbPath = tempDbPath();
    // Register agent A over real MCP.
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
    await bootstrap.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
    );
    let agentId: string;
    let sessionToken: string;
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const reg = (await bootstrap.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: credential.credential_id,
          init_token: secret,
          name: "agent-a",
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      agentId = reg.structuredContent["agent_id"] as string;
      sessionToken = reg.structuredContent["session_token"] as string;
    } finally {
      await bootstrap.close();
      await app.close();
    }

    const out = await withClient(dbPath, sessionToken!, async (client) => {
      const result = (await client.callTool({
        name: "create_task",
        arguments: {
          title: "Do the thing",
          description: "details",
          trace_parent: "00-abc-def-01",
        },
      })) as { structuredContent: Record<string, unknown> };
      return result.structuredContent;
    });

    expect(out["created_by"]).toBe(agentId!);
    expect(out["coordinator"]).toBe(agentId!);
    expect(out["status"]).toBe("to_do");
    expect(out["version"]).toBe(1);
    expect(out["lease_generation"]).toBe(1);
    expect(typeof out["lease_expires_at"]).toBe("string");
    expect(out["assigned_to"]).toEqual([]);
    expect(out["title"]).toBe("Do the thing");
    expect(out["trace_parent"]).toBe("00-abc-def-01");
    expect(out["task_id"]).toMatch(/^[0-9a-f-]{36}$/);

    // Durable: visible through the service layer on a fresh handle.
    const check = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const stored = getTask(check.db!, out["task_id"] as string);
      expect(stored).toMatchObject({
        title: "Do the thing",
        created_by: agentId!,
        coordinator: agentId!,
        status: "to_do",
      });
    } finally {
      await check.close();
    }
  });

  it("the creator cannot be spoofed: no created_by input exists", async () => {
    const dbPath = tempDbPath();
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
    await bootstrap.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
    );
    let agentA = "";
    let agentB = "";
    let tokenA = "";
    try {
      for (const [name, set] of [
        [
          "agent-a",
          (id: string, tok: string) => {
            agentA = id;
            tokenA = tok;
          },
        ],
        [
          "agent-b",
          (id: string) => {
            agentB = id;
          },
        ],
      ] as const) {
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
        set(
          reg.structuredContent["agent_id"] as string,
          reg.structuredContent["session_token"] as string,
        );
      }
    } finally {
      await bootstrap.close();
      await app.close();
    }

    await withClient(dbPath, tokenA, async (client) => {
      const tools = await client.listTools();
      const schema = tools.tools.find((t) => t.name === "create_task")!
        .inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(schema.properties ?? {})).not.toContain("created_by");
      expect(Object.keys(schema.properties ?? {})).not.toContain("coordinator");

      // Even a smuggled created_by cannot take effect: the tool either
      // rejects the call or records the authenticated caller.
      const result = (await client.callTool({
        name: "create_task",
        arguments: { title: "spoof attempt", created_by: agentB },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      if (!result.isError) {
        expect(result.structuredContent!["created_by"]).toBe(agentA);
        expect(result.structuredContent!["coordinator"]).toBe(agentA);
      }
    });
  });

  it("unauthenticated create_task is rejected at the HTTP layer", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_task", arguments: { title: "x" } },
        }),
      });
      expect(res.status).toBe(401);
      await res.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("database failures surface as database_error without SQL leakage", async () => {
    const dbPath = tempDbPath();
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
    await bootstrap.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
    );
    let sessionToken = "";
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const reg = (await bootstrap.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: credential.credential_id,
          init_token: secret,
          name: "agent-a",
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      sessionToken = reg.structuredContent["session_token"] as string;
      // Break the schema between requests: create_task's INSERT now
      // throws a better-sqlite3 SqliteError.
      app.db!.prepare("DROP TABLE tasks").run();
    } finally {
      await bootstrap.close();
      await app.close();
    }

    await withClient(dbPath, sessionToken, async (client) => {
      const result = (await client.callTool({
        name: "create_task",
        arguments: { title: "Doomed task" },
      })) as { isError?: boolean };
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result);
      expect(text).toContain("database_error");
      expect(text).not.toMatch(/SQLITE|no such table/i);
    });
  });

  it("blank titles are schema-rejected as invalid params", async () => {
    const dbPath = tempDbPath();
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
    await bootstrap.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
    );
    let sessionToken = "";
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const reg = (await bootstrap.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: credential.credential_id,
          init_token: secret,
          name: "agent-a",
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      sessionToken = reg.structuredContent["session_token"] as string;
    } finally {
      await bootstrap.close();
      await app.close();
    }

    await withClient(dbPath, sessionToken, async (client) => {
      for (const title of ["", "   "]) {
        const result = (await client.callTool({
          name: "create_task",
          arguments: { title },
        })) as { isError?: boolean };
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("-32602");
      }
    });
  });
});
