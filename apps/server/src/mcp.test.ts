import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { mintCredential } from "./credentials.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-mcp-")), "test.db");
}

async function registerSessionToken(
  dbPath: string,
  name: string,
): Promise<{ agentId: string; sessionToken: string }> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
  const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
  await bootstrap.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  try {
    const { credential, secret } = mintCredential(app.db!, { type: "init" });
    const result = (await bootstrap.callTool({
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
    };
  } finally {
    await bootstrap.close();
    await app.close();
  }
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}${MCP_PATH}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

describe("MCP transport (component 2, real session auth)", () => {
  it("real client lists and invokes ping -> { ok: true, agent_id }", async () => {
    const dbPath = tempDbPath();
    const { agentId, sessionToken } = await registerSessionToken(
      dbPath,
      "agent-a",
    );
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const client = await connect(app.url, sessionToken);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("ping");

      const result = await client.callTool({ name: "ping", arguments: {} });
      const structured = (result as { structuredContent?: unknown })
        .structuredContent;
      expect(structured).toEqual({ ok: true, agent_id: agentId });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("malformed MCP requests are rejected cleanly", async () => {
    const dbPath = tempDbPath();
    const { sessionToken } = await registerSessionToken(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
        },
        body: "this is not json",
      });
      expect(res.status).toBe(400);
      // Server stays alive for a subsequent valid call.
      const client = await connect(app.url, sessionToken);
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain("ping");
      } finally {
        await client.close();
      }
    } finally {
      await app.close();
    }
  });

  it("every initialize gets its own session: no single-session wedge", async () => {
    // Regression: one shared transport accepted exactly one initialize
    // for the process lifetime, so the first client (even anonymous)
    // permanently blocked every other agent.
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const sessionIds: Array<string | null> = [];
      for (let i = 0; i < 2; i += 1) {
        const res = await fetch(`${app.url}${MCP_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: `client-${i}`, version: "0.0.0" },
            },
          }),
        });
        expect(res.status).toBe(200);
        sessionIds.push(res.headers.get("mcp-session-id"));
        await res.body?.cancel();
      }
      expect(sessionIds[0]).toBeTruthy();
      expect(sessionIds[1]).toBeTruthy();
      expect(sessionIds[1]).not.toBe(sessionIds[0]);
    } finally {
      await app.close();
    }
  });

  it("two agents run concurrently on one server with their own identities and fleet view", async () => {
    const dbPath = tempDbPath();
    const agentA = await registerSessionToken(dbPath, "agent-a");
    const agentB = await registerSessionToken(dbPath, "agent-b");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const clientA = await connect(app.url, agentA.sessionToken);
    const clientB = await connect(app.url, agentB.sessionToken);
    try {
      const pingA = (await clientA.callTool({ name: "ping", arguments: {} }))
        .structuredContent;
      expect(pingA).toEqual({ ok: true, agent_id: agentA.agentId });
      const pingB = (await clientB.callTool({ name: "ping", arguments: {} }))
        .structuredContent;
      expect(pingB).toEqual({ ok: true, agent_id: agentB.agentId });

      // Fleet flow on a single production server: A writes, B reads.
      await clientA.callTool({
        name: "create_task",
        arguments: { title: "A writes, B reads" },
      });
      const list = await clientB.callTool({
        name: "get_tasks",
        arguments: {},
      });
      expect(JSON.stringify(list)).toContain("A writes, B reads");
    } finally {
      await clientA.close();
      await clientB.close();
      await app.close();
    }
  });

  it("oversized MCP bodies are rejected with 413 before any session work", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "big", version: "0.0.0" },
            junk: "x".repeat(1024 * 1024 + 1),
          },
        }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
      // The server still serves a normal request after the rejection.
      const ok = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "small", version: "0.0.0" },
          },
        }),
      });
      expect(ok.status).toBe(200);
      await ok.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("session routing: unknown id 404, missing id 400, terminated session 404", async () => {
    const dbPath = tempDbPath();
    const { sessionToken } = await registerSessionToken(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        Authorization: `Bearer ${sessionToken}`,
      };
      const init = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "c", version: "0.0.0" },
          },
        }),
      });
      expect(init.status).toBe(200);
      const sid = init.headers.get("mcp-session-id");
      expect(sid).toBeTruthy();
      await init.body?.cancel();

      const ping = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" });

      // Non-initialize request without a session id -> 400 (-32000).
      const noSid = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers,
        body: ping,
      });
      expect(noSid.status).toBe(400);
      expect(JSON.parse(await noSid.text()).error.code).toBe(-32000);

      // Unknown session id -> 404 (-32001).
      const unknown = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": "not-a-session" },
        body: ping,
      });
      expect(unknown.status).toBe(404);
      expect(JSON.parse(await unknown.text()).error.code).toBe(-32001);

      // Valid session id -> 200.
      const ok = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sid! },
        body: ping,
      });
      expect(ok.status).toBe(200);
      await ok.body?.cancel();

      // DELETE terminates the session; later use -> 404.
      const del = await fetch(`${app.url}${MCP_PATH}`, {
        method: "DELETE",
        headers: { ...headers, "mcp-session-id": sid! },
      });
      expect(del.status).toBe(200);
      await del.body?.cancel();
      const after = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": sid! },
        body: ping,
      });
      expect(after.status).toBe(404);
      await after.body?.cancel();
    } finally {
      await app.close();
    }
  });
});
