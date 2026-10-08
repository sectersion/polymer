import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { extractBearerToken } from "./auth.js";
import { mintCredential } from "./credentials.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-sess-")), "test.db");
}

type App = Awaited<ReturnType<typeof listen>>;
type Db = NonNullable<App["db"]>;

// Each client gets its own server, all sharing one SQLite file (the
// fleet view); servers accept many sessions now (mcp.test.ts).
async function withAnonClient<T>(
  dbPath: string,
  fn: (client: Client, db: Db) => Promise<T>,
): Promise<T> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
  const client = new Client({ name: "bootstrap", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  try {
    return await fn(client, app.db!);
  } finally {
    await client.close();
    await app.close();
  }
}

async function withAuthedClient<T>(
  dbPath: string,
  token: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return await fn(client);
  } finally {
    await client.close();
    await app.close();
  }
}

interface Registered {
  agentId: string;
  sessionToken: string;
  reconnectSecret: string;
}

async function registerAgent(
  client: Client,
  db: Db,
  name: string,
): Promise<Registered> {
  const { credential, secret } = mintCredential(db, { type: "init" });
  const result = (await client.callTool({
    name: "register_agent",
    arguments: {
      init_token_id: credential.credential_id,
      init_token: secret,
      name,
      role: "coder",
    },
  })) as { structuredContent: Record<string, unknown> };
  return {
    agentId: result.structuredContent["agent_id"] as string,
    sessionToken: result.structuredContent["session_token"] as string,
    reconnectSecret: result.structuredContent["reconnect_secret"] as string,
  };
}

async function pingStructured(
  client: Client,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const result = await client.callTool({ name: "ping", arguments: args });
  return (result as { structuredContent?: unknown }).structuredContent;
}

describe("Session authentication on ping (component 8)", () => {
  it("two registered agents each receive their own identity", async () => {
    const dbPath = tempDbPath();
    const a = await withAnonClient(dbPath, (c, db) =>
      registerAgent(c, db, "a"),
    );
    const b = await withAnonClient(dbPath, (c, db) =>
      registerAgent(c, db, "b"),
    );
    expect(a.agentId).not.toBe(b.agentId);
    await withAuthedClient(dbPath, a.sessionToken, async (c) => {
      expect(await pingStructured(c)).toEqual({
        ok: true,
        agent_id: a.agentId,
      });
    });
    await withAuthedClient(dbPath, b.sessionToken, async (c) => {
      expect(await pingStructured(c)).toEqual({
        ok: true,
        agent_id: b.agentId,
      });
    });
  });

  it("a caller-supplied agent_id cannot impersonate another agent", async () => {
    const dbPath = tempDbPath();
    const a = await withAnonClient(dbPath, (c, db) =>
      registerAgent(c, db, "a"),
    );
    const b = await withAnonClient(dbPath, (c, db) =>
      registerAgent(c, db, "b"),
    );
    await withAuthedClient(dbPath, a.sessionToken, async (c) => {
      expect(await pingStructured(c, { agent_id: b.agentId })).toEqual({
        ok: true,
        agent_id: a.agentId,
      });
    });
  });

  it("missing, invalid, reconnect, and expired credentials are rejected", async () => {
    const dbPath = tempDbPath();
    const a = await withAnonClient(dbPath, (c, db) =>
      registerAgent(c, db, "a"),
    );
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const ping = (auth?: string) =>
        fetch(`${app.url}${MCP_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "ping", arguments: {} },
          }),
        });

      const missing = await ping();
      expect(missing.status).toBe(401);
      await missing.body?.cancel();

      for (const bad of [
        "deadbeef.0123456789abcdef0123456789abcdef0123456789abcdef012345",
        a.reconnectSecret,
      ]) {
        const res = await ping(bad);
        expect(res.status).toBe(401);
        await res.body?.cancel();
      }

      // Expire the session credential server-side: it must stop working.
      app
        .db!.prepare(
          "UPDATE credentials SET expires_at = '2000-01-01T00:00:00.000Z' WHERE type = 'agent_session'",
        )
        .run();
      const expired = await ping(a.sessionToken);
      expect(expired.status).toBe(401);
      await expired.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("a revoked session credential stops working", async () => {
    const dbPath = tempDbPath();
    const a = await withAnonClient(dbPath, (c, db) =>
      registerAgent(c, db, "a"),
    );
    await withAuthedClient(dbPath, a.sessionToken, async (c) => {
      expect(await pingStructured(c)).toEqual({
        ok: true,
        agent_id: a.agentId,
      });
    });
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      app
        .db!.prepare(
          "UPDATE credentials SET status = 'revoked' WHERE type = 'agent_session'",
        )
        .run();
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${a.sessionToken}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      await res.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("a server without a database fails closed on MCP calls", async () => {
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer anything.at.all",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      await res.body?.cancel();
      const health = await fetch(`${app.url}/health`);
      expect(health.status).toBe(200);
      await health.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("unauthenticated GET and DELETE on /mcp are rejected", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    try {
      const get = await fetch(`${app.url}${MCP_PATH}`, { method: "GET" });
      expect(get.status).toBe(401);
      await get.body?.cancel();
      const del = await fetch(`${app.url}${MCP_PATH}`, { method: "DELETE" });
      expect(del.status).toBe(401);
      await del.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("unit: bearer extractor matrix", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("Bearer   ")).toBeUndefined();
    expect(extractBearerToken(["Bearer abc", "Bearer def"])).toBe("abc");
  });
});
