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

export function toolResult(body: ToolBody): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: ToolBody;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
  };
}
