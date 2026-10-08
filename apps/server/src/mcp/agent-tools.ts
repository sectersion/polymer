import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PolymerDatabase } from "../db.js";
import { registerAgent, registerSubagent } from "../registration.js";
import {
  callerAgentId,
  heartbeatSchema,
  registrationError,
  toolResult,
} from "./shared.js";

export function registerAgentTools(
  server: McpServer,
  db: PolymerDatabase | null,
): void {
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
}
