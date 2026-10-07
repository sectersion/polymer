import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./index.js";

export const MCP_PATH = "/mcp";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "polymer", version: VERSION });
  server.registerTool(
    "ping",
    { description: "Liveness probe (component 2)", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: '{"ok":true}' }],
      structuredContent: { ok: true },
    }),
  );
  return server;
}
