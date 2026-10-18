import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PolymerDatabase } from "../database/db.js";
import type { EventBus } from "../http/events.js";
import { registerAgent, registerSubagent } from "../identity/registration.js";
import { getAgentById, listAgentsPage } from "../identity/agents.js";
import {
  HeartbeatUnauthorizedError,
  recordHeartbeat,
} from "../identity/watchdog.js";
import { AgentNotFoundError } from "../identity/agents.js";
import {
  callerAgentId,
  heartbeatSchema,
  registrationError,
  taskToolError,
  toolResult,
} from "./shared.js";

export function registerAgentTools(
  server: McpServer,
  db: PolymerDatabase | null,
  events: EventBus,
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
        name: z.string().min(1).max(64),
        role: z.string().min(1).max(96),
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
        events.publish("agent.status_changed", {
          agent_id: out.agent_id,
          name: args.name,
          status: "connecting",
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
        name: z.string().min(1).max(64),
        role: z.string().min(1).max(96),
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
        events.publish("agent.status_changed", {
          agent_id: out.agent_id,
          name: args.name,
          status: "connecting",
        });
        return toolResult({ ...out });
      } catch (err) {
        registrationError(err);
      }
    },
  );
  server.registerTool(
    "get_agent_roster",
    {
      description:
        "List fleet agents with liveness state (session auth only; any authenticated agent may read). Exact-match status/role/parent_agent_id filters; limit default 50, max 500, opaque cursor.",
      inputSchema: {
        status: z.string().optional(),
        role: z.string().optional(),
        parent_agent_id: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      if (callerAgentId(extra) === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      try {
        const page = listAgentsPage(db, {
          status: args.status,
          role: args.role,
          parentAgentId: args.parent_agent_id,
          limit: args.limit,
          cursor: args.cursor,
        });
        return toolResult({
          agents: page.agents.map((agent) => ({
            agent_id: agent.agent_id,
            name: agent.name,
            role: agent.role,
            status: agent.status,
            last_seen: agent.last_seen,
            parent_agent_id: agent.parent_agent_id,
          })),
          next_cursor: page.next_cursor,
        });
      } catch (err) {
        const code = (err as { code?: unknown } | undefined)?.code;
        if (
          typeof code === "string" &&
          (code === "invalid_status" ||
            code === "invalid_cursor" ||
            code === "invalid_request")
        ) {
          throw new McpError(ErrorCode.InvalidRequest, code);
        }
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "get_agent_info",
    {
      description:
        "Detail for one agent, including task counts (session auth only; fleet-wide read)",
      inputSchema: { agent_id: z.string().min(1) },
    },
    async (args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      if (callerAgentId(extra) === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      const agent = getAgentById(db, args.agent_id);
      if (agent === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "agent_not_found");
      }
      const tasksCreated = (
        db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE created_by = ?")
          .get(agent.agent_id) as { n: number }
      ).n;
      const tasksAssigned = (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM task_assignments WHERE agent_id = ?",
          )
          .get(agent.agent_id) as { n: number }
      ).n;
      return toolResult({
        agent_id: agent.agent_id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        last_seen: agent.last_seen,
        connected_at: agent.connected_at,
        parent_agent_id: agent.parent_agent_id,
        heartbeat_timeout_seconds: agent.heartbeat_timeout_seconds,
        tasks_created: tasksCreated,
        tasks_assigned: tasksAssigned,
      });
    },
  );
  server.registerTool(
    "send_heartbeat",
    {
      description:
        "Heartbeat: refresh agent liveness (last_seen now; idle, or working while coordinating a live lease; disabled agents are rejected)",
      inputSchema: {},
    },
    async (_args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      const caller = callerAgentId(extra);
      if (caller === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      try {
        return toolResult(recordHeartbeat(db, caller));
      } catch (err) {
        if (err instanceof HeartbeatUnauthorizedError) {
          throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
        }
        if (err instanceof AgentNotFoundError) {
          throw new McpError(ErrorCode.InvalidRequest, "agent_not_found");
        }
        throw err;
      }
    },
  );
}
