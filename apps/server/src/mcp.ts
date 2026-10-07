import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VERSION } from "./index.js";
import type { PolymerDatabase } from "./db.js";
import {
  registerAgent,
  registerSubagent,
  RegistrationError,
} from "./registration.js";

export const MCP_PATH = "/mcp";

const heartbeatSchema = z.number().int().positive().optional();

function callerAgentId(extra: unknown): string | undefined {
  const agentId = (extra as { authInfo?: { extra?: { agentId?: unknown } } })
    ?.authInfo?.extra?.agentId;
  return typeof agentId === "string" && agentId !== "" ? agentId : undefined;
}

function registrationError(err: unknown): never {
  if (err instanceof RegistrationError) {
    throw new McpError(ErrorCode.InvalidRequest, err.code);
  }
  throw err;
}

function toolResult(body: { [key: string]: string | number | boolean }): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: { [key: string]: string | number | boolean };
} {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

export function createMcpServer(db: PolymerDatabase | null = null): McpServer {
  const server = new McpServer({ name: "polymer", version: VERSION });
  server.registerTool(
    "ping",
    {
      description:
        "Liveness probe (requires agent session auth; agent_id args are ignored)",
      inputSchema: { agent_id: z.string().optional() },
    },
    async (_args, extra) => {
      const agentId = callerAgentId(extra);
      if (agentId === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      return toolResult({ ok: true, agent_id: agentId });
    },
  );
  server.registerTool(
    "register_agent",
    {
      description:
        "Register a top-level agent with a single-use init-token OTP (unauthenticated; session tokens are rejected)",
      inputSchema: {
        init_token_id: z.string(),
        init_token: z.string(),
        name: z.string(),
        role: z.string(),
        heartbeat_timeout_seconds: heartbeatSchema,
      },
    },
    async (args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      if (callerAgentId(extra) !== undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      try {
        const out = registerAgent(db, {
          initTokenId: args.init_token_id,
          initToken: args.init_token,
          name: args.name,
          role: args.role,
          heartbeatTimeoutSeconds: args.heartbeat_timeout_seconds,
        });
        return toolResult({ ...out });
      } catch (err) {
        registrationError(err);
      }
    },
  );
  server.registerTool(
    "register_subagent",
    {
      description:
        "Spawn a subagent; the server sets parent_agent_id to the caller (session auth only)",
      inputSchema: {
        name: z.string(),
        role: z.string(),
        heartbeat_timeout_seconds: heartbeatSchema,
      },
    },
    async (args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      const caller = callerAgentId(extra);
      if (caller === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      try {
        const out = registerSubagent(db, caller, {
          name: args.name,
          role: args.role,
          heartbeatTimeoutSeconds: args.heartbeat_timeout_seconds,
        });
        return toolResult({ ...out });
      } catch (err) {
        registrationError(err);
      }
    },
  );
  return server;
}
