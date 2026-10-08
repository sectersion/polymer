import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RegistrationError } from "../identity/registration.js";
import {
  TaskAgentNotFoundError,
  TaskAlreadyAssignedError,
  TaskAlreadyClaimedError,
  TaskInvalidStatusError,
  TaskNotAssignedError,
  TaskNotFoundError,
  TaskUnauthorizedError,
  TaskVersionMismatchError,
  PingNotFoundError,
  type Task,
} from "../tasks/index.js";

export const heartbeatSchema = z.number().int().positive().optional();

export function callerAgentId(extra: unknown): string | undefined {
  const agentId = (extra as { authInfo?: { extra?: { agentId?: unknown } } })
    ?.authInfo?.extra?.agentId;
  return typeof agentId === "string" && agentId !== "" ? agentId : undefined;
}

export function registrationError(err: unknown): never {
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
    | null
    | ReadonlyArray<unknown>
    | Record<string, unknown>;
};

export function taskToolError(err: unknown): never {
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
    err instanceof PingNotFoundError ||
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
export function taskListItem(task: Task, assignedTo: string[]) {
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

export function toolResult(body: ToolBody): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolBody;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}
