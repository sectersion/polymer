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
import {
  TaskAgentNotFoundError,
  TaskInvalidStatusError,
  createTask,
  getTask,
  listTaskAssignees,
  listTasks,
  type Task,
} from "./tasks.js";

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

type ToolBody = {
  [key: string]:
    | string
    | number
    | boolean
    | string[]
    | null
    | ReadonlyArray<Record<string, unknown>>;
};

function taskToolError(err: unknown): never {
  if (err instanceof McpError) throw err;
  if (err instanceof TaskInvalidStatusError) {
    throw new McpError(ErrorCode.InvalidRequest, err.code);
  }
  // Driver failures are server-side: catalog maps database_error → 503.
  if (err instanceof Error && err.name === "SqliteError") {
    throw new McpError(ErrorCode.InternalError, "database_error");
  }
  if (err instanceof Error) {
    throw new McpError(ErrorCode.InvalidRequest, err.message);
  }
  throw err;
}

/** Fleet-wide task summary: the same serialization `create_task` returns. */
function taskListItem(task: Task, assignedTo: string[]) {
  return {
    task_id: task.task_id,
    title: task.title,
    status: task.status,
    created_by: task.created_by,
    coordinator: task.coordinator,
    assigned_to: assignedTo,
    version: task.version,
    lease_generation: task.lease_generation,
    lease_expires_at: task.lease_expires_at,
    trace_parent: task.trace_parent,
    created_at: task.created_at,
  };
}

function toolResult(body: ToolBody): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolBody;
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
  server.registerTool(
    "create_task",
    {
      description:
        "Create a task; the authenticated caller becomes creator and coordinator (session auth only)",
      inputSchema: {
        title: z.string().min(1),
        description: z.string().optional(),
        trace_parent: z.string().optional(),
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
        const task = createTask(db, {
          title: args.title,
          description: args.description,
          traceParent: args.trace_parent,
          createdBy: caller,
        });
        return toolResult({
          task_id: task.task_id,
          title: task.title,
          status: task.status,
          created_by: task.created_by,
          coordinator: task.coordinator,
          assigned_to: [],
          version: task.version,
          lease_generation: task.lease_generation,
          lease_expires_at: task.lease_expires_at,
          trace_parent: task.trace_parent,
          created_at: task.created_at,
        });
      } catch (err) {
        if (err instanceof TaskAgentNotFoundError) {
          throw new McpError(ErrorCode.InvalidRequest, err.code);
        }
        if (err instanceof Error) {
          throw new McpError(ErrorCode.InvalidRequest, err.message);
        }
        throw err;
      }
    },
  );
  server.registerTool(
    "get_tasks",
    {
      description:
        "List fleet tasks with optional filters (session auth only; any authenticated agent may read all tasks)",
      inputSchema: {
        status: z.string().optional(),
        created_by: z.string().optional(),
        assigned_to: z.string().optional(),
        limit: z.number().int().optional(),
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
        const tasks = listTasks(db, {
          status: args.status,
          createdBy: args.created_by,
          assignedTo: args.assigned_to,
          limit: args.limit,
        });
        return toolResult({
          tasks: tasks.map((task) =>
            taskListItem(
              task,
              listTaskAssignees(db, task.task_id).map((a) => a.agent_id),
            ),
          ),
        });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "get_task_detail",
    {
      description:
        "Full detail for one task, including assignees (session auth only; fleet-wide read)",
      inputSchema: { task_id: z.string().min(1) },
    },
    async (args, extra) => {
      if (db === null) {
        throw new McpError(ErrorCode.InternalError, "database_error");
      }
      if (callerAgentId(extra) === undefined) {
        throw new McpError(ErrorCode.InvalidRequest, "unauthorized");
      }
      try {
        const task = getTask(db, args.task_id);
        if (task === undefined) {
          throw new McpError(ErrorCode.InvalidRequest, "task_not_found");
        }
        return toolResult({
          task_id: task.task_id,
          title: task.title,
          description: task.description,
          status: task.status,
          version: task.version,
          created_by: task.created_by,
          coordinator: task.coordinator,
          lease_generation: task.lease_generation,
          lease_expires_at: task.lease_expires_at,
          trace_parent: task.trace_parent,
          assigned_to: listTaskAssignees(db, task.task_id).map(
            (a) => a.agent_id,
          ),
          // Comments arrive with component 17; shape is spec-stable now.
          comments: [],
          has_more: false,
          created_at: task.created_at,
          updated_at: task.updated_at,
        });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  return server;
}
