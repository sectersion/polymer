import { randomUUID } from "node:crypto";
import { getAgentById } from "../identity/agents.js";
import type { PolymerDatabase } from "../database/db.js";
import {
  AgentDisabledError,
  TaskAgentNotFoundError,
  TaskInvalidStatusError,
} from "./errors.js";

/**
 * Loose-end A: `disabled` is an explicit admin revocation of an
 * agent's write agency, so every task/comment mutation rejects it
 * with `unauthorized`. Reads stay open (they cannot mutate, and the
 * disable path deliberately keeps sessions authenticating so the
 * specific rejection codes stay reachable). `disconnected` is NOT
 * gated — a slow-but-legitimate agent heartbeats back to life, and
 * gating it would turn every network blip into a write outage.
 * Unknown agents fall through to each mutation's own not-found
 * error; this guard only fires on a known disabled row.
 */
export function requireActiveAgent(db: PolymerDatabase, agentId: string): void {
  const agent = getAgentById(db, agentId);
  if (agent !== undefined && agent.status === "disabled") {
    throw new AgentDisabledError(agentId);
  }
}

export const TASK_STATUSES = [
  "to_do",
  "in_progress",
  "done",
  "failed",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Default initial lease on task creation (seconds). */
export const TASK_LEASE_DEFAULT_SECONDS = 3600;

export interface Task {
  task_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  version: number;
  created_by: string;
  coordinator: string;
  lease_expires_at: string | null;
  lease_generation: number;
  trace_parent: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskAssignment {
  id: number;
  task_id: string;
  agent_id: string;
  assigned_at: string;
}
function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

const TASK_COLUMNS = `task_id, title, description, status, version,
  created_by, coordinator, lease_expires_at, lease_generation,
  trace_parent, created_at, updated_at`;

function toTask(row: Record<string, unknown>): Task {
  return {
    task_id: row["task_id"] as string,
    title: row["title"] as string,
    description: (row["description"] as string | null) ?? null,
    status: row["status"] as TaskStatus,
    version: row["version"] as number,
    created_by: row["created_by"] as string,
    coordinator: row["coordinator"] as string,
    lease_expires_at: (row["lease_expires_at"] as string | null) ?? null,
    lease_generation: row["lease_generation"] as number,
    trace_parent: (row["trace_parent"] as string | null) ?? null,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

interface CreateTaskInput {
  title: string;
  description?: string | null;
  traceParent?: string | null;
  createdBy: string;
  /** Defaults to the creator: the creator coordinates with an initial lease. */
  coordinator?: string;
  leaseDurationSeconds?: number;
}

/**
 * Component 10: create a task over raw SQL. The creator becomes
 * coordinator with an initial lease (`lease_generation: 1`,
 * `lease_expires_at: now + leaseDurationSeconds`) while status stays
 * `to_do`. Trace context is stored opaque. Agent references are
 * validated before the insert (FKs enforce it regardless).
 */
export function createTask(db: PolymerDatabase, input: CreateTaskInput): Task {
  const title = input.title.trim();
  if (title === "") throw new Error("task title must not be empty");
  requireActiveAgent(db, input.createdBy);
  if (getAgentById(db, input.createdBy) === undefined) {
    throw new TaskAgentNotFoundError(input.createdBy);
  }
  const coordinator = input.coordinator ?? input.createdBy;
  if (getAgentById(db, coordinator) === undefined) {
    throw new TaskAgentNotFoundError(coordinator);
  }
  const leaseDuration =
    input.leaseDurationSeconds ?? TASK_LEASE_DEFAULT_SECONDS;
  if (!Number.isInteger(leaseDuration) || leaseDuration <= 0) {
    throw new Error("lease_duration_seconds must be a positive integer");
  }
  const now = Date.now();
  const row = db
    .prepare(
      `INSERT INTO tasks (task_id, title, description, status, version,
         created_by, coordinator, lease_expires_at, lease_generation,
         trace_parent, created_at, updated_at)
       VALUES (?, ?, ?, 'to_do', 1, ?, ?, ?, 1, ?, ?, ?)
       RETURNING ${TASK_COLUMNS}`,
    )
    .get(
      randomUUID(),
      title,
      input.description ?? null,
      input.createdBy,
      coordinator,
      new Date(now + leaseDuration * 1000).toISOString(),
      input.traceParent ?? null,
      new Date(now).toISOString(),
      new Date(now).toISOString(),
    ) as Record<string, unknown> | undefined;
  if (!row) throw new Error("task insert returned no row");
  return toTask(row);
}

export function getTask(db: PolymerDatabase, taskId: string): Task | undefined {
  const row = db
    .prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE task_id = ?`)
    .get(taskId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toTask(row);
}

interface ListTasksInput {
  status?: string;
  createdBy?: string;
  assignedTo?: string;
  coordinator?: string;
  q?: string;
  orderBy?: string;
  orderDir?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Component 10 (extended in 12): list tasks. `limit` defaults to 50
 * and caps at 500 (mirrors the MCP/REST list conventions).
 * `assignedTo` filters to tasks holding an assignment row for that
 * agent. `coordinator` filters to the current owning agent. `q` is a
 * case-insensitive substring match on `title`. `orderBy` is
 * `created_at` (default) or `updated_at`; `orderDir` is `asc`
 * (default) or `desc`. Ordering tie-breaks on rowid so pagination is
 * stable. `cursor` pages forward from the last returned
 * (order-key, rowid) tuple (see encodeTaskCursor).
 */
export function listTasks(
  db: PolymerDatabase,
  input: ListTasksInput = {},
): Task[] {
  if (input.status !== undefined && !isTaskStatus(input.status)) {
    throw new TaskInvalidStatusError(input.status);
  }
  const order = normalizeOrder(input);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  const desc = order.orderDir === "DESC";
  const cursor =
    input.cursor === undefined ? undefined : decodeTaskCursor(input.cursor);
  const where = taskWhere(input);
  const joiner = where.sql.length > 0 ? " AND" : " WHERE";
  const cursorSql =
    cursor === undefined
      ? ""
      : taskCursorPredicate(desc).sql(joiner, order.orderBy);
  const params: unknown[] =
    cursor === undefined
      ? [...where.params, limit]
      : [
          ...where.params,
          cursor.orderValue,
          cursor.orderValue,
          cursor.rowid,
          limit,
        ];
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       ${where.sql}${cursorSql}
       ORDER BY ${order.orderBy} ${order.orderDir}, rowid ${order.orderDir} LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];
  return rows.map(toTask);
}

/** Reader for a task's assignees (writers arrive with later components). */
export function listTaskAssignees(
  db: PolymerDatabase,
  taskId: string,
): TaskAssignment[] {
  const rows = db
    .prepare(
      `SELECT id, task_id, agent_id, assigned_at FROM task_assignments
       WHERE task_id = ? ORDER BY assigned_at ASC, rowid ASC`,
    )
    .all(taskId) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row["id"] as number,
    task_id: row["task_id"] as string,
    agent_id: row["agent_id"] as string,
    assigned_at: row["assigned_at"] as string,
  }));
}

/**
 * Opaque pagination cursor for REST list routes: the rowid of the
 * last returned row, base64url-encoded. Shared by task lists and
 * comment pages so the encoding never drifts between surfaces.
 */
export function encodeCursor(rowid: number): string {
  return Buffer.from(`c${rowid}`, "utf8").toString("base64url");
}

/** Inverse of encodeCursor; throws `invalid_cursor` on tampering. */
export function decodeCursor(cursor: string): number {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  if (!raw.startsWith("c")) {
    throw catalogError("invalid_cursor");
  }
  const rowid = Number(raw.slice(1));
  if (!Number.isInteger(rowid) || rowid < 0) {
    throw catalogError("invalid_cursor");
  }
  return rowid;
}

/** An Error carrying its catalog code, for HTTP-safe mapping. */
export function catalogError(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

/**
 * Task-list cursor: the (order-key, rowid) tuple of the last returned
 * row, base64url-encoded. A bare rowid is NOT a valid task cursor: with
 * `orderBy=updated_at` the rowid alone can skip or duplicate rows when
 * timestamps tie or interleave, so the order key travels with it.
 * Legacy `c<rowid>` cursors are rejected as `invalid_cursor`.
 */
function encodeTaskCursor(rowid: number, orderValue: string): string {
  return Buffer.from(`t${rowid}:${orderValue}`, "utf8").toString("base64url");
}

/** Inverse of encodeTaskCursor; throws `invalid_cursor` on tampering. */
function decodeTaskCursor(cursor: string): {
  rowid: number;
  orderValue: string;
} {
  let raw = "";
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw catalogError("invalid_cursor");
  }
  const match = /^t(\d+):([\s\S]*)$/.exec(raw);
  if (match === null) throw catalogError("invalid_cursor");
  const rowid = Number(match[1]);
  if (!Number.isInteger(rowid) || rowid < 0) {
    throw catalogError("invalid_cursor");
  }
  return { rowid, orderValue: match[2] as string };
}

/** Tuple-keyset predicate for stable forward paging under any order. */
function taskCursorPredicate(desc: boolean): {
  sql: (joiner: string, orderBy: string) => string;
} {
  return {
    sql: (joiner: string, orderBy: string) =>
      desc
        ? `${joiner} (${orderBy} < ? OR (${orderBy} = ? AND rowid < ?))`
        : `${joiner} (${orderBy} > ? OR (${orderBy} = ? AND rowid > ?))`,
  };
}

interface TaskFilters {
  status?: string;
  createdBy?: string;
  assignedTo?: string;
  coordinator?: string;
  q?: string;
  orderBy?: string;
  orderDir?: string;
}

/** Ordering for both list shapes; unknown values are invalid_request. */
function normalizeOrder(input: { orderBy?: string; orderDir?: string }): {
  orderBy: "created_at" | "updated_at";
  orderDir: "ASC" | "DESC";
} {
  const orderBy = input.orderBy === undefined ? "created_at" : input.orderBy;
  if (orderBy !== "created_at" && orderBy !== "updated_at") {
    throw catalogError("invalid_request");
  }
  const dir = (input.orderDir ?? "asc").toLowerCase();
  if (dir !== "asc" && dir !== "desc") {
    throw catalogError("invalid_request");
  }
  return { orderBy, orderDir: dir === "desc" ? "DESC" : "ASC" };
}

/** Escape LIKE wildcards so `q` is always a literal substring match. */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** Shared WHERE construction for both list shapes (MCP + REST). */
function taskWhere(input: TaskFilters): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
    if (!isTaskStatus(input.status)) {
      throw new TaskInvalidStatusError(input.status);
    }
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.createdBy !== undefined) {
    where.push("created_by = ?");
    params.push(input.createdBy);
  }
  if (input.assignedTo !== undefined) {
    where.push(
      `EXISTS (SELECT 1 FROM task_assignments
         WHERE task_assignments.task_id = tasks.task_id
           AND task_assignments.agent_id = ?)`,
    );
    params.push(input.assignedTo);
  }
  if (input.coordinator !== undefined) {
    where.push("coordinator = ?");
    params.push(input.coordinator);
  }
  if (input.q !== undefined) {
    where.push("title LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(input.q)}%`);
  }
  return {
    sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

interface ListTasksPageInput extends TaskFilters {
  limit?: number;
  cursor?: string;
}

/**
 * Component 18: cursor-paginated task read. Shares the tuple-keyset
 * cursor grammar and the filter/ordering surface with listTasks; MCP
 * get_tasks mirrors this grammar (same `cursor` param, same
 * `next_cursor` shape). `next_cursor` is null once exhausted. The
 * cursor carries the last row's (order-key, rowid); rowid-only cursors
 * from other surfaces are rejected as `invalid_cursor`.
 */
export function listTasksPage(
  db: PolymerDatabase,
  input: ListTasksPageInput = {},
): { tasks: Task[]; next_cursor: string | null } {
  if (input.status !== undefined && !isTaskStatus(input.status)) {
    throw new TaskInvalidStatusError(input.status);
  }
  const order = normalizeOrder(input);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  const desc = order.orderDir === "DESC";
  const cursor =
    input.cursor === undefined ? undefined : decodeTaskCursor(input.cursor);
  const where = taskWhere(input);
  const joiner = where.sql.length > 0 ? " AND" : " WHERE";
  const cursorSql =
    cursor === undefined
      ? ""
      : taskCursorPredicate(desc).sql(joiner, order.orderBy);
  const params: unknown[] =
    cursor === undefined
      ? [...where.params, limit + 1]
      : [
          ...where.params,
          cursor.orderValue,
          cursor.orderValue,
          cursor.rowid,
          limit + 1,
        ];
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, ${TASK_COLUMNS} FROM tasks
       ${where.sql}${cursorSql}
       ORDER BY ${order.orderBy} ${order.orderDir}, rowid ${order.orderDir} LIMIT ?`,
    )
    .all(...params) as Array<Record<string, unknown> & { _rowid: number }>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    tasks: page.map(toTask),
    next_cursor:
      hasMore && last !== undefined
        ? encodeTaskCursor(last._rowid, String(last[order.orderBy] as unknown))
        : null,
  };
}
