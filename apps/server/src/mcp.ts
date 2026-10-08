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
  TaskAlreadyAssignedError,
  TaskAlreadyClaimedError,
  TaskInvalidStatusError,
  TaskNotAssignedError,
  TaskNotFoundError,
  TaskUnauthorizedError,
  TaskVersionMismatchError,
  assignTask,
  claimTask,
  createTask,
  getTask,
  listTaskAssignees,
  listTasks,
  requestUnassignment,
  testLeaseWrite,
  transferCoordinator,
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
  if (
    err instanceof TaskNotFoundError ||
    err instanceof TaskAlreadyClaimedError ||
    err instanceof TaskVersionMismatchError ||
    err instanceof TaskUnauthorizedError ||
    err instanceof TaskAlreadyAssignedError ||
    err instanceof TaskNotAssignedError ||
    err instanceof TaskAgentNotFoundError
  ) {
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

export interface McpServerOptions {
  /**
   * Component 14: register test-only probe tools (`__test_lease_write`)
   * alongside the real surface. Default false — probes never ship in
   * production builds; the full POLYMER.json config loader arrives with
   * its component, this option is its gate seam until then.
   */
  testSeams: boolean;
}

const DEFAULT_MCP_SERVER_OPTIONS: McpServerOptions = { testSeams: false };

export function createMcpServer(
  db: PolymerDatabase | null = null,
  options: McpServerOptions = DEFAULT_MCP_SERVER_OPTIONS,
): McpServer {
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
        title: z
          .string()
          .min(1)
          .refine((s) => s.trim().length > 0, "title must not be empty"),
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
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "claim_task",
    {
      description:
        "Atomically claim a task: become its coordinator with a live lease (session auth only). Renewing your own live lease keeps the generation; acquiring from unleased/expired starts a new one",
      inputSchema: {
        task_id: z.string().min(1),
        lease_duration_seconds: z.number().int().positive().optional(),
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
        const out = claimTask(
          db,
          args.task_id,
          caller,
          args.lease_duration_seconds,
        );
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
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
        limit: z.number().int().min(1).max(500).optional(),
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
        // One read transaction: task rows and their assignee rows come
        // from a single SQLite snapshot, so a concurrent writer between
        // the statements cannot produce a torn composite (e.g. a fresh
        // version paired with stale assigned_to).
        const tasks = db.transaction(() => {
          const rows = listTasks(db, {
            status: args.status,
            createdBy: args.created_by,
            assignedTo: args.assigned_to,
            limit: args.limit,
          });
          return rows.map((task) => ({
            task,
            assigneeIds: listTaskAssignees(db, task.task_id).map(
              (a) => a.agent_id,
            ),
          }));
        })();
        return toolResult({
          tasks: tasks.map(({ task, assigneeIds }) =>
            taskListItem(task, assigneeIds),
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
        // One read transaction: task + assignees from a single
        // snapshot (see get_tasks).
        const detail = db.transaction(() => {
          const task = getTask(db, args.task_id);
          if (task === undefined) return undefined;
          return {
            task,
            assigneeIds: listTaskAssignees(db, task.task_id).map(
              (a) => a.agent_id,
            ),
          };
        })();
        if (detail === undefined) {
          throw new McpError(ErrorCode.InvalidRequest, "task_not_found");
        }
        const { task, assigneeIds } = detail;
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
          assigned_to: assigneeIds,
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
  server.registerTool(
    "assign_task",
    {
      description:
        "Attach agents to a task (coordinator only, live lease; integer lease_generation and expected_version fence the write; assigns version only, generation unchanged)",
      inputSchema: {
        task_id: z.string().min(1),
        agent_ids: z.array(z.string().min(1)).min(1),
        lease_generation: z.number().int(),
        expected_version: z.number().int(),
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
        const out = assignTask(
          db,
          args.task_id,
          caller,
          args.agent_ids,
          args.lease_generation,
          args.expected_version,
        );
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "transfer_coordinator",
    {
      description:
        "Hand the task to a registered agent assigned to it (coordinator only, live lease; bumps version and lease_generation, renews the lease; the old coordinator's in-flight writes reject on the stale generation)",
      inputSchema: {
        task_id: z.string().min(1),
        new_coordinator_id: z.string().min(1),
        lease_generation: z.number().int(),
        expected_version: z.number().int(),
        lease_duration_seconds: z.number().int().positive().optional(),
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
        const out = transferCoordinator(
          db,
          args.task_id,
          caller,
          args.new_coordinator_id,
          args.lease_generation,
          args.expected_version,
          args.lease_duration_seconds,
        );
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "request_unassignment",
    {
      description:
        "Give up your own assignment row on a task (the assigned agent only; touches nothing else)",
      inputSchema: {
        task_id: z.string().min(1),
        reason: z.string().optional(),
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
        const out = requestUnassignment(db, args.task_id, caller, args.reason);
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  if (options.testSeams) {
    // Component 14 probe: exists only when testSeams is set in
    // config; never present in production builds. Proves the shared
    // fencing guard in isolation via a no-op write.
    server.registerTool(
      "__test_lease_write",
      {
        description:
          "Test-only: run a no-op write through the coordinator lease guard (testSeams builds only)",
        inputSchema: {
          task_id: z.string().min(1),
          lease_generation: z.number().int(),
          expected_version: z.number().int(),
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
          const out = testLeaseWrite(
            db,
            args.task_id,
            caller,
            args.lease_generation,
            args.expected_version,
          );
          return toolResult({ ...out });
        } catch (err) {
          taskToolError(err);
        }
      },
    );
  }
  return server;
}
