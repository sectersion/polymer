import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PolymerDatabase } from "../database/db.js";
import type { EventBus } from "../http/events.js";
import {
  COMMENT_PAGE_MAX,
  getComments,
  getUnreadPings,
  markPingRead,
  postComment,
} from "../tasks/index.js";
import { callerAgentId, taskToolError, toolResult } from "./shared.js";

/**
 * Component 17: the communication surface. Sender identity always
 * comes from the authenticated caller (no sender argument exists);
 * mention parsing follows the contract token grammar exactly; pings
 * are private to the mentioned agent (no cross-agent oracle: someone
 * else's mention_id answers not_found). Comment pagination is the one
 * MCP surface with a cursor (design: comment listings deviate from the
 * limit/offset-free rule on purpose).
 */
export function registerCommentTools(
  server: McpServer,
  db: PolymerDatabase | null,
  events: EventBus,
): void {
  server.registerTool(
    "post_comment",
    {
      description:
        "Post a comment on a task as the authenticated agent (@agent_name mentions notify; unknown or wrong-case @names notify no one)",
      inputSchema: {
        task_id: z.string().min(1),
        content: z
          .string()
          .min(1)
          .refine((s) => s.trim().length > 0, "content must not be empty"),
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
        const out = postComment(
          db,
          args.task_id,
          caller,
          args.content,
          args.trace_parent,
        );
        events.publish("comment.created", {
          comment_id: out.comment_id,
          task_id: out.task_id,
          sender_agent_id: out.sender_agent_id,
          content: out.content,
        });
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "get_comments",
    {
      description:
        "Chronological comment history for a task (cursor-paginated; limit default 50, maximum 500)",
      inputSchema: {
        task_id: z.string().min(1),
        limit: z.number().int().min(1).max(COMMENT_PAGE_MAX).optional(),
        cursor: z.string().min(1).optional(),
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
        const out = getComments(db, args.task_id, args.limit, args.cursor);
        return toolResult({ ...out });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
  server.registerTool(
    "get_unread_pings",
    {
      description:
        "The caller's own unread mentions, oldest first (no arguments; identity is the session)",
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
      const out = getUnreadPings(db, caller);
      return toolResult({
        pings: out.map((ping) => ({ ...ping })),
      });
    },
  );
  server.registerTool(
    "mark_ping_read",
    {
      description:
        "Mark one of your own pings read (idempotent; a foreign or unknown mention_id answers not_found)",
      inputSchema: { mention_id: z.string().min(1) },
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
        const out = markPingRead(db, caller, args.mention_id);
        return toolResult({ success: out.success });
      } catch (err) {
        taskToolError(err);
      }
    },
  );
}
