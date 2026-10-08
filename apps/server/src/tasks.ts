import { randomUUID } from "node:crypto";
import { getAgentById } from "./agents.js";
import type { PolymerDatabase } from "./db.js";

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

export class TaskAgentNotFoundError extends Error {
  readonly code = "agent_not_found";
  constructor(agentId: string) {
    super(`agent not found: ${agentId}`);
    this.name = "TaskAgentNotFoundError";
  }
}

export class TaskInvalidStatusError extends Error {
  readonly code = "invalid_status";
  constructor(status: string) {
    super(`invalid task status: ${status}`);
    this.name = "TaskInvalidStatusError";
  }
}

export class TaskNotFoundError extends Error {
  readonly code = "task_not_found";
  constructor(taskId: string) {
    super(`task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskAlreadyClaimedError extends Error {
  readonly code = "task_already_claimed";
  constructor(taskId: string) {
    super(`task already claimed: ${taskId}`);
    this.name = "TaskAlreadyClaimedError";
  }
}

export class TaskVersionMismatchError extends Error {
  readonly code = "version_mismatch";
  constructor(taskId: string) {
    super(`version mismatch: ${taskId}`);
    this.name = "TaskVersionMismatchError";
  }
}

export class TaskUnauthorizedError extends Error {
  readonly code = "unauthorized";
  constructor(taskId: string) {
    super(`not coordinator with a live lease: ${taskId}`);
    this.name = "TaskUnauthorizedError";
  }
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
  const where: string[] = [];
  const params: unknown[] = [];
  if (input.status !== undefined) {
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
  const rows = db
    .prepare(
      `SELECT ${TASK_COLUMNS} FROM tasks
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[];
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

export interface ClaimTaskResult {
  task_id: string;
  title: string;
  status: "in_progress";
  coordinator: string;
  version: number;
  lease_expires_at: string;
  lease_generation: number;
}

/**
 * Component 13: atomic lock acquisition over the claim matrix. One
 * IMMEDIATE transaction verifies claimability, establishes the
 * coordinator + lease, and updates state/version. Success always ends
 * `in_progress` with the caller as coordinator: `to_do -> in_progress`
 * is claim-only (transition table), so renewal must produce it too.
 *
 * Renew (own live lease): expiry extended, version bumped, generation
 * unchanged. Fresh claim / reclaim (`to_do` or `failed`, unleased or
 * expired): version AND generation bumped. `done` is terminal
 * (`invalid_status`). A live lease held by another agent is
 * `task_already_claimed`; NULL expiry reads as expired immediately.
 */
export function claimTask(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  leaseDurationSeconds: number = TASK_LEASE_DEFAULT_SECONDS,
): ClaimTaskResult {
  if (!Number.isInteger(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
    throw new Error("lease_duration_seconds must be a positive integer");
  }
  const claim = db.transaction(() => {
    const task = getTask(db, taskId);
    if (task === undefined) {
      throw new TaskNotFoundError(taskId);
    }
    if (task.status === "done") {
      throw new TaskInvalidStatusError(task.status);
    }
    const now = new Date().toISOString();
    // NULL expiry reads as expired: only a NON-null expiry that is
    // still ahead of now can block anyone.
    const live = task.lease_expires_at !== null && task.lease_expires_at > now;
    const mine = task.coordinator === caller;
    if (live && !mine) {
      throw new TaskAlreadyClaimedError(task.task_id);
    }
    const version = task.version + 1;
    // Renew keeps the ownership epoch; acquisition starts a new one.
    const leaseGeneration = live
      ? task.lease_generation
      : task.lease_generation + 1;
    const leaseExpiresAt = new Date(
      Date.now() + leaseDurationSeconds * 1000,
    ).toISOString();
    // Guarded write: the version the row was read at is part of the
    // WHERE (belt and braces — the IMMEDIATE transaction already
    // serializes writers). Zero changes would be a lost update.
    const updated = db
      .prepare(
        `UPDATE tasks
            SET status = 'in_progress', coordinator = ?, version = ?,
                lease_expires_at = ?, lease_generation = ?, updated_at = ?
          WHERE task_id = ? AND version = ?`,
      )
      .run(
        caller,
        version,
        leaseExpiresAt,
        leaseGeneration,
        now,
        task.task_id,
        task.version,
      );
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    return {
      task_id: task.task_id,
      title: task.title,
      status: "in_progress" as const,
      coordinator: caller,
      version,
      lease_expires_at: leaseExpiresAt,
      lease_generation: leaseGeneration,
    };
  });
  return claim.immediate();
}

/**
 * Component 14: the shared fencing guard all coordinator mutations
 * (components 15-16, admin paths) call INSIDE their transaction.
 * Re-reads the task and validates, together in that one transaction:
 * caller == coordinator, live lease (`lease_expires_at > now`, NULL is
 * expired), current lease_generation, expected_version.
 *
 * Returns the verified row so the mutation writes against a version
 * it just validated. Errors: `task_not_found`; `unauthorized` when the
 * caller is not the coordinator or their lease is expired (former
 * coordinators are read-only); `version_mismatch` for a stale
 * lease_generation or expected_version (catalog: both are 409 the
 * optimistic-lock conflict).
 */
export function assertCoordinatorLease(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  leaseGeneration: number,
  expectedVersion: number,
): Task {
  const task = getTask(db, taskId);
  if (task === undefined) {
    throw new TaskNotFoundError(taskId);
  }
  if (task.coordinator !== caller) {
    throw new TaskUnauthorizedError(task.task_id);
  }
  const now = new Date().toISOString();
  const live = task.lease_expires_at !== null && task.lease_expires_at > now;
  if (!live) {
    throw new TaskUnauthorizedError(task.task_id);
  }
  if (task.lease_generation !== leaseGeneration) {
    throw new TaskVersionMismatchError(task.task_id);
  }
  if (task.version !== expectedVersion) {
    throw new TaskVersionMismatchError(task.task_id);
  }
  return task;
}

/** Output of the component-14 probe write; the shape every coordinator
 * mutation output starts from (`task_id`, `version`, `updated_at`). */
export interface LeasedWriteResult {
  task_id: string;
  version: number;
  updated_at: string;
}

/**
 * Component 14 probe (testSeams builds only): runs a no-op write
 * through the guard — version and updated_at only — in the exact
 * transaction shape every coordinator mutation will use (guard +
 * guarded write in one IMMEDIATE transaction). Never registered in
 * production.
 */
export function testLeaseWrite(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  leaseGeneration: number,
  expectedVersion: number,
): LeasedWriteResult {
  const write = db.transaction(() => {
    const task = assertCoordinatorLease(
      db,
      taskId,
      caller,
      leaseGeneration,
      expectedVersion,
    );
    const version = task.version + 1;
    const updated_at = new Date().toISOString();
    const updated = db
      .prepare(
        `UPDATE tasks SET version = ?, updated_at = ?
          WHERE task_id = ? AND version = ?`,
      )
      .run(version, updated_at, task.task_id, task.version);
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    return { task_id: task.task_id, version, updated_at };
  });
  return write.immediate();
}
