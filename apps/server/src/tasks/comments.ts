import { randomUUID } from "node:crypto";
import type { PolymerDatabase } from "../database/db.js";
import { getAgentByName } from "../identity/agents.js";
import { TaskNotFoundError } from "./errors.js";
import { getTask } from "./store.js";

export const COMMENT_PAGE_DEFAULT = 50;
export const COMMENT_PAGE_MAX = 500;
/** get_task_detail embeds at most this many newest comments. */
export const DETAIL_EMBEDDED_COMMENTS = 20;

export interface Comment {
  comment_id: string;
  task_id: string;
  sender_agent_id: string | null;
  sender_type: "agent" | "human";
  content: string;
  trace_parent: string | null;
  created_at: string;
}

export interface Mention {
  mention_id: string;
  comment_id: string;
  mentioned_agent_id: string;
  read: boolean;
  created_at: string;
}

/** Catalog `not_found` — deliberately shared with unknown ids so a
 * mention cannot be probed for existence across agents. */
export class PingNotFoundError extends Error {
  readonly code = "not_found";
  constructor(mentionId: string) {
    super(`ping not found: ${mentionId}`);
    this.name = "PingNotFoundError";
  }
}

const COMMENT_COLUMNS = `comment_id, task_id, sender_agent_id, sender_type,
  content, trace_parent, created_at`;

function toComment(row: Record<string, unknown>): Comment {
  return {
    comment_id: row["comment_id"] as string,
    task_id: row["task_id"] as string,
    sender_agent_id: (row["sender_agent_id"] as string | null) ?? null,
    sender_type: row["sender_type"] as "agent" | "human",
    content: row["content"] as string,
    trace_parent: (row["trace_parent"] as string | null) ?? null,
    created_at: row["created_at"] as string,
  };
}

/**
 * Component 17: post a comment on a task (identity comes from the
 * authenticated caller, never arguments) and resolve its mentions in
 * the same transaction.
 */
export interface PostCommentResult {
  comment_id: string;
  task_id: string;
  sender_agent_id: string;
  content: string;
  mentions: string[];
  trace_parent: string | null;
  created_at: string;
}

/** Resolve `@name` tokens to agent ids (exact, case-sensitive). */
function resolveMentions(db: PolymerDatabase, content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(/@([A-Za-z0-9_-]+)/g)) {
    const agent = getAgentByName(db, match[1]);
    if (agent === undefined) continue;
    if (!ids.includes(agent.agent_id)) ids.push(agent.agent_id);
  }
  return ids;
}

export function postComment(
  db: PolymerDatabase,
  taskId: string,
  senderAgentId: string,
  content: string,
  traceParent?: string,
): PostCommentResult {
  const post = db.transaction(() => {
    if (getTask(db, taskId) === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    const now = new Date().toISOString();
    const commentId = randomUUID();
    db.prepare(
      `INSERT INTO comments
         (comment_id, task_id, sender_agent_id, sender_type, content, trace_parent, created_at)
       VALUES (?, ?, ?, 'agent', ?, ?, ?)`,
    ).run(commentId, taskId, senderAgentId, content, traceParent ?? null, now);
    const mentions = resolveMentions(db, content);
    for (const mentionedAgentId of mentions) {
      db.prepare(
        `INSERT INTO mentions
           (mention_id, comment_id, mentioned_agent_id, read, created_at)
         VALUES (?, ?, ?, 0, ?)`,
      ).run(randomUUID(), commentId, mentionedAgentId, now);
    }
    return {
      comment_id: commentId,
      task_id: taskId,
      sender_agent_id: senderAgentId,
      content,
      mentions,
      trace_parent: traceParent ?? null,
      created_at: now,
    };
  });
  return post.immediate();
}

export interface UnreadPing {
  mention_id: string;
  comment_id: string;
  task_id: string;
  sender_agent_id: string | null;
  content: string;
  created_at: string;
}

/** Component 17: the caller's own unread mentions, oldest first. */
export function getUnreadPings(
  db: PolymerDatabase,
  caller: string,
): UnreadPing[] {
  const rows = db
    .prepare(
      `SELECT m.mention_id, m.comment_id, c.task_id, c.sender_agent_id,
              c.content, m.created_at
         FROM mentions m JOIN comments c ON c.comment_id = m.comment_id
        WHERE m.mentioned_agent_id = ? AND m.read = 0
        ORDER BY m.created_at ASC, m.rowid ASC`,
    )
    .all(caller) as Record<string, unknown>[];
  return rows.map((row) => ({
    mention_id: row["mention_id"] as string,
    comment_id: row["comment_id"] as string,
    task_id: row["task_id"] as string,
    sender_agent_id: (row["sender_agent_id"] as string | null) ?? null,
    content: row["content"] as string,
    created_at: row["created_at"] as string,
  }));
}

/** Component 17: mark one of the caller's OWN pings read. Another
 * agent's mention_id and unknown ids both answer `not_found` — no
 * existence oracle across agents. Idempotent on an already-read ping. */
export function markPingRead(
  db: PolymerDatabase,
  caller: string,
  mentionId: string,
): { success: true } {
  const updated = db
    .prepare(
      "UPDATE mentions SET read = 1 WHERE mention_id = ? AND mentioned_agent_id = ?",
    )
    .run(mentionId, caller);
  if (updated.changes !== 1) {
    throw new PingNotFoundError(mentionId);
  }
  return { success: true };
}

export interface CommentPage {
  comments: Comment[];
  next_cursor: string | null;
}

/** Opaque pagination cursor: the rowid of the last returned row. */
function encodeCursor(rowid: number): string {
  return Buffer.from(`c${rowid}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  if (!raw.startsWith("c")) throw new Error("invalid_cursor");
  const rowid = Number(raw.slice(1));
  if (!Number.isInteger(rowid) || rowid < 0) {
    throw new Error("invalid_cursor");
  }
  return rowid;
}

/** Component 17: chronological comment history, cursor-paginated
 * (limit defaults to 50, caps at 500 — list conventions). */
export function getComments(
  db: PolymerDatabase,
  taskId: string,
  limit?: number,
  cursor?: string,
): CommentPage {
  if (getTask(db, taskId) === undefined) {
    throw new TaskNotFoundError(taskId);
  }
  const pageSize = limit ?? COMMENT_PAGE_DEFAULT;
  if (
    !Number.isInteger(pageSize) ||
    pageSize <= 0 ||
    pageSize > COMMENT_PAGE_MAX
  ) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  const rowid = cursor === undefined ? 0 : decodeCursor(cursor);
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, ${COMMENT_COLUMNS} FROM comments
        WHERE task_id = ? AND rowid > ?
        ORDER BY rowid ASC LIMIT ?`,
    )
    .all(taskId, rowid, pageSize + 1) as Array<
    Record<string, unknown> & { _rowid: number }
  >;
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  return {
    comments: page.map(toComment),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]._rowid) : null,
  };
}

/** Latest N comments for get_task_detail's embedded window. */
export function latestComments(
  db: PolymerDatabase,
  taskId: string,
  count: number,
): { comments: Comment[]; has_more: boolean } {
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, ${COMMENT_COLUMNS} FROM comments
        WHERE task_id = ? ORDER BY rowid ASC`,
    )
    .all(taskId) as Array<Record<string, unknown> & { _rowid: number }>;
  const hasMore = rows.length > count;
  const window = hasMore ? rows.slice(rows.length - count) : rows;
  return { comments: window.map(toComment), has_more: hasMore };
}
