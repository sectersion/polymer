import { getAgentById } from "../identity/agents.js";
import type { PolymerDatabase } from "../database/db.js";
import {
  TASK_LEASE_DEFAULT_SECONDS,
  getTask,
  listTaskAssignees,
  type TaskStatus,
} from "./store.js";
import {
  TaskAgentNotFoundError,
  TaskAlreadyAssignedError,
  TaskInvalidStatusError,
  TaskNotAssignedError,
  TaskNotFoundError,
  TaskVersionMismatchError,
} from "./errors.js";
import { assertCoordinatorLease } from "./lease.js";

export interface AssignTaskResult {
  task_id: string;
  assigned_to: string[];
  version: number;
  lease_generation: number;
  updated_at: string;
}

/**
 * Component 15: coordinator-only assignment through the guard. Every
 * target agent must exist (`agent_not_found`) and not already hold a
 * row (`already_assigned`; caller duplicates in the list are
 * collapsed). Assignment is not an ownership-epoch change: `version`
 * bumps, `lease_generation` is unchanged. All-or-nothing: any failure
 * leaves no rows and no version bump.
 */
export function assignTask(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  agentIds: string[],
  leaseGeneration: number,
  expectedVersion: number,
): AssignTaskResult {
  if (agentIds.length === 0) {
    throw new Error("agent_ids must not be empty");
  }
  const assign = db.transaction(() => {
    const task = assertCoordinatorLease(
      db,
      taskId,
      caller,
      leaseGeneration,
      expectedVersion,
    );
    const targets = [...new Set(agentIds)];
    const existing = listTaskAssignees(db, taskId);
    for (const agentId of targets) {
      if (getAgentById(db, agentId) === undefined) {
        throw new TaskAgentNotFoundError(agentId);
      }
      if (existing.some((a) => a.agent_id === agentId)) {
        throw new TaskAlreadyAssignedError(task.task_id, agentId);
      }
    }
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO task_assignments (task_id, agent_id, assigned_at) VALUES (?, ?, ?)",
    );
    for (const agentId of targets) {
      insert.run(task.task_id, agentId, now);
    }
    const version = task.version + 1;
    const updated = db
      .prepare(
        "UPDATE tasks SET version = ?, updated_at = ? WHERE task_id = ? AND version = ?",
      )
      .run(version, now, task.task_id, task.version);
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    return {
      task_id: task.task_id,
      assigned_to: listTaskAssignees(db, task.task_id).map((a) => a.agent_id),
      version,
      lease_generation: task.lease_generation,
      updated_at: now,
    };
  });
  return assign.immediate();
}

export interface TransferCoordinatorResult {
  task_id: string;
  coordinator: string;
  version: number;
  lease_generation: number;
  lease_expires_at: string;
  updated_at: string;
}

/**
 * Component 15: hand the task to a registered agent that already holds
 * a TaskAssignment row (`not_assigned` otherwise). The transfer IS an
 * ownership-epoch change: `lease_generation` increments (an in-flight
 * write from the old coordinator rejects on the stale generation), and
 * the new coordinator inherits a fresh lease (`lease_duration_seconds`
 * or the server default) rather than a possibly expiring one.
 */
export function transferCoordinator(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  newCoordinatorId: string,
  leaseGeneration: number,
  expectedVersion: number,
  leaseDurationSeconds?: number,
): TransferCoordinatorResult {
  const duration = leaseDurationSeconds ?? TASK_LEASE_DEFAULT_SECONDS;
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error("lease_duration_seconds must be a positive integer");
  }
  const transfer = db.transaction(() => {
    const task = assertCoordinatorLease(
      db,
      taskId,
      caller,
      leaseGeneration,
      expectedVersion,
    );
    if (getAgentById(db, newCoordinatorId) === undefined) {
      throw new TaskAgentNotFoundError(newCoordinatorId);
    }
    if (
      !listTaskAssignees(db, taskId).some(
        (a) => a.agent_id === newCoordinatorId,
      )
    ) {
      throw new TaskNotAssignedError(task.task_id, newCoordinatorId);
    }
    const version = task.version + 1;
    const leaseGeneration1 = task.lease_generation + 1;
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + duration * 1000).toISOString();
    const updated = db
      .prepare(
        `UPDATE tasks SET coordinator = ?, version = ?,
            lease_generation = ?, lease_expires_at = ?, updated_at = ?
          WHERE task_id = ? AND version = ?`,
      )
      .run(
        newCoordinatorId,
        version,
        leaseGeneration1,
        leaseExpiresAt,
        now,
        task.task_id,
        task.version,
      );
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    return {
      task_id: task.task_id,
      coordinator: newCoordinatorId,
      version,
      lease_generation: leaseGeneration1,
      lease_expires_at: leaseExpiresAt,
      updated_at: now,
    };
  });
  return transfer.immediate();
}

export interface UnassignmentResult {
  success: true;
  message: string;
}

/**
 * Component 15: the assigned agent itself gives up its row. No guard:
 * assignment is not ownership and the delete touches nothing else —
 * coordinator, lease, and status are untouched (observers learn of the
 * handoff through comments, not state).
 */
export function requestUnassignment(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  reason?: string,
): UnassignmentResult {
  const task = getTask(db, taskId);
  if (task === undefined) {
    throw new TaskNotFoundError(taskId);
  }
  const deleted = db
    .prepare("DELETE FROM task_assignments WHERE task_id = ? AND agent_id = ?")
    .run(taskId, caller);
  if (deleted.changes !== 1) {
    throw new TaskNotAssignedError(taskId, caller);
  }
  return {
    success: true,
    message:
      reason === undefined || reason.trim() === ""
        ? "unassigned"
        : `unassigned: ${reason.trim()}`,
  };
}

export interface TaskStatusMutationResult {
  task_id: string;
  status: TaskStatus;
  version: number;
  updated_at: string;
}

/**
 * Component 16: coordinator-only status mutation through the guard.
 * The MCP transition table (force lives on the REST admin surface
 * only):
 *
 *     to_do -> in_progress   claim_task/admin-claim only (never update)
 *     in_progress -> done    allowed (clears the lease)
 *     in_progress -> failed  allowed (clears the lease)
 *     failed -> to_do        live lease required (guard provides it)
 *     failed -> in_progress  claim_task reclaim only
 *     done -> *              TERMINAL — never reaches the table
 *
 * Entering done/failed clears the lease (`lease_expires_at = NULL`):
 * generation is unchanged — clearing leaves the ownership epoch alone;
 * recovery to a working epoch goes through claim_task. Everything not
 * listed is `invalid_status`; guard failures surface as
 * `unauthorized` / `version_mismatch` before the table is consulted.
 */
export function updateTaskStatus(
  db: PolymerDatabase,
  taskId: string,
  caller: string,
  status: TaskStatus,
  leaseGeneration: number,
  expectedVersion: number,
): TaskStatusMutationResult {
  const allowedTransitions: Partial<Record<TaskStatus, TaskStatus[]>> = {
    in_progress: ["done", "failed"],
    failed: ["to_do"],
  };
  const write = db.transaction(() => {
    const task = assertCoordinatorLease(
      db,
      taskId,
      caller,
      leaseGeneration,
      expectedVersion,
    );
    if (!(allowedTransitions[task.status] ?? []).includes(status)) {
      throw new TaskInvalidStatusError(status);
    }
    const version = task.version + 1;
    const now = new Date().toISOString();
    const clearsLease = status === "done" || status === "failed";
    const updated = db
      .prepare(
        `UPDATE tasks SET status = ?, version = ?,
            lease_expires_at = ?, updated_at = ?
          WHERE task_id = ? AND version = ?`,
      )
      .run(
        status,
        version,
        clearsLease ? null : task.lease_expires_at,
        now,
        task.task_id,
        task.version,
      );
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    return {
      task_id: task.task_id,
      status,
      version,
      updated_at: now,
    };
  });
  return write.immediate();
}
