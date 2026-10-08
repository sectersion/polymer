import { randomUUID } from "node:crypto";
import { getAgentById } from "../identity/agents.js";
import type { PolymerDatabase } from "../database/db.js";
import { TaskAgentNotFoundError, TaskInvalidStatusError } from "./errors.js";

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

export interface TaskAssignment {
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

export interface CreateTaskInput {
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

export interface ListTasksInput {
  status?: string;
  createdBy?: string;
  assignedTo?: string;
  limit?: number;
}

/**
 * Component 10 (extended in 12): list tasks, newest last. `limit`
 * defaults to 50 and caps at 500 (mirrors the MCP/REST list
 * conventions). `assignedTo` filters to tasks holding an assignment
 * row for that agent.
 */
export function listTasks(
  db: PolymerDatabase,
  input: ListTasksInput = {},
): Task[] {
  if (input.status !== undefined && !isTaskStatus(input.status)) {
    throw new TaskInvalidStatusError(input.status);
  }
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  const where = taskWhere(input);
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       ${where.sql}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...where.params, limit) as Record<string, unknown>[];
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

export interface TaskFilters {
  status?: string;
  createdBy?: string;
  assignedTo?: string;
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
  return {
    sql: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export interface ListTasksPageInput extends TaskFilters {
  limit?: number;
  cursor?: string;
}

/**
 * Component 18: cursor-paginated task read for the REST surface (the
 * MCP tool keeps its limit-only contract — no cursor param there, by
 * design). Same ordering and limits as listTasks; `next_cursor` is
 * null once the collection is exhausted.
 */
export function listTasksPage(
  db: PolymerDatabase,
  input: ListTasksPageInput = {},
): { tasks: Task[]; next_cursor: string | null } {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new Error("limit must be an integer between 1 and 500");
  }
  const cursorRowid =
    input.cursor === undefined ? 0 : decodeCursor(input.cursor);
  const where = taskWhere(input);
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, ${TASK_COLUMNS} FROM tasks
       ${where.sql}${where.sql.length > 0 ? " AND rowid > ?" : " WHERE rowid > ?"}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...where.params, cursorRowid, limit + 1) as Array<
    Record<string, unknown> & { _rowid: number }
  >;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    tasks: page.map(toTask),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]._rowid) : null,
  };
}
