import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VERSION } from "./index.js";

export const MCP_PATH = "/mcp";

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "polymer", version: VERSION });
  server.registerTool(
    "ping",
    {
      description:
        "Liveness probe (component 3: requires authentication; agent_id args are ignored)",
      inputSchema: { agent_id: z.string().optional() },
    },
    async (_args, extra) => {
      const agentId = (
        extra?.authInfo?.extra as { agentId?: unknown } | undefined
      )?.agentId;
      if (typeof agentId !== "string" || agentId === "") {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, agent_id: agentId }) },
        ],
        structuredContent: { ok: true, agent_id: agentId },
      };
    },
  );
  return server;
}
