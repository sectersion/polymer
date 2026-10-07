import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { clearTestCredentials, mintTestCredential } from "./auth.js";

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}${MCP_PATH}`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  return client;
}

describe("MCP transport (component 2, now authenticated)", () => {
  beforeEach(() => {
    clearTestCredentials();
  });

  it("real client lists and invokes ping -> { ok: true, agent_id }", async () => {
    const { token } = mintTestCredential("agent-a");
    const app = await listen("127.0.0.1", 0);
    const client = await connect(app.url, token);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("ping");

      const result = await client.callTool({ name: "ping", arguments: {} });
      const structured = (result as { structuredContent?: unknown })
        .structuredContent;
      expect(structured).toEqual({ ok: true, agent_id: "agent-a" });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("malformed MCP requests are rejected cleanly", async () => {
    const { token } = mintTestCredential("agent-a");
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: "this is not json",
      });
      expect(res.status).toBe(400);
      // Server stays alive for a subsequent valid call.
      const client = await connect(app.url, token);
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
