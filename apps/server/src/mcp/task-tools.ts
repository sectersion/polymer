import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { PolymerDatabase } from "../database/db.js";
import type { EventBus } from "../http/events.js";
import {
  TASK_STATUSES,
  assignTask,
  claimTask,
  createTask,
  getTaskDetail,
  listTaskAssignees,
  listTasks,
  requestUnassignment,
  serializeTaskDetail,
  taskListItem,
  transferCoordinator,
  updateTaskStatus,
} from "../tasks/index.js";
import { callerAgentId, taskToolError, toolResult } from "./shared.js";

export function registerTaskTools(
  server: McpServer,
  db: PolymerDatabase | null,
  events: EventBus,
): void {
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
        events.publish("task.created", {
          task_id: task.task_id,
          title: task.title,
          status: task.status,
          coordinator: task.coordinator,
          version: task.version,
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
        events.publish("task.updated", {
          task_id: out.task_id,
          status: out.status,
          coordinator: out.coordinator,
          version: out.version,
          lease_generation: out.lease_generation,
        });
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
        // One read transaction: task + assignees + the embedded
        // comment window all come from a single snapshot (the same
        // composite REST serves).
        const detail = getTaskDetail(db, args.task_id);
        if (detail === undefined) {
          throw new McpError(ErrorCode.InvalidRequest, "task_not_found");
        }
        return toolResult(serializeTaskDetail(detail));
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
        events.publish("task.updated", {
          task_id: out.task_id,
          change: "assigned",
          assigned_to: out.assigned_to,
          version: out.version,
          lease_generation: out.lease_generation,
        });
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
        events.publish("task.updated", {
          task_id: out.task_id,
          change: "transfer_coordinator",
          coordinator: out.coordinator,
          version: out.version,
          lease_generation: out.lease_generation,
        });
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
  server.registerTool(
    "update_task_status",
    {
      description:
        "Coordinator-only status transition through the lease guard (integer lease_generation and expected_version fence the write): in_progress -> done|failed clears the lease, failed -> to_do requeues, to_do and failed -> in_progress go through claim_task, done is terminal",
      inputSchema: {
        task_id: z.string().min(1),
        status: z.enum(TASK_STATUSES),
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
        const out = updateTaskStatus(
          db,
          args.task_id,
          caller,
          args.status,
          args.lease_generation,
          args.expected_version,
        );
        events.publish("task.updated", {
          task_id: out.task_id,
          status: out.status,
          version: out.version,
        });
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
}
