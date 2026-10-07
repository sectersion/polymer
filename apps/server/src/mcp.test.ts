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
});
