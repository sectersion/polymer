import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${url}${MCP_PATH}`),
  );
  await client.connect(transport);
  return client;
}

describe("MCP transport (component 2)", () => {
  it("real client lists and invokes ping -> { ok: true }", async () => {
    const app = await listen("127.0.0.1", 0);
    const client = await connect(app.url);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("ping");

      const result = await client.callTool({ name: "ping", arguments: {} });
      const structured = (result as { structuredContent?: unknown })
        .structuredContent;
      expect(structured).toEqual({ ok: true });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("malformed MCP requests are rejected cleanly", async () => {
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "this is not json",
      });
      expect(res.status).toBe(400);
      // Server stays alive for a subsequent valid call.
      const client = await connect(app.url);
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
