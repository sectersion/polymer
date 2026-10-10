import { getAgentById } from "../identity/agents.js";
import { recordAudit } from "../identity/audit.js";
import type { PolymerDatabase } from "../database/db.js";
import {
  TASK_LEASE_DEFAULT_SECONDS,
  getTask,
  listTaskAssignees,
  type Task,
  type TaskStatus,
} from "./store.js";
import {
  TaskAgentNotFoundError,
  TaskAlreadyAssignedError,
  TaskAlreadyClaimedError,
  TaskInvalidStatusError,
  TaskNotAssignedError,
  TaskNotFoundError,
  TaskVersionMismatchError,
} from "./errors.js";
import { assertCoordinatorLease, type ClaimTaskResult } from "./lease.js";

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

/** The MCP/REST-identical transition table (PATCH force never overrides it). */
const TASK_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  in_progress: ["done", "failed"],
  failed: ["to_do"],
};

/** Illegal transition anywhere → invalid_status. */
export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!(TASK_TRANSITIONS[from] ?? []).includes(to)) {
    throw new TaskInvalidStatusError(to);
  }
}

function auditSnapshot(task: Task | Record<string, unknown>) {
  const t = task as Record<string, unknown>;
  return {
    status: t["status"],
    coordinator: t["coordinator"],
    version: t["version"],
    lease_generation: t["lease_generation"],
    lease_expires_at: t["lease_expires_at"],
  };
}

function ensureInt(value: number | undefined, taskId: string): void {
  if (value !== undefined && !Number.isInteger(value)) {
    throw new TaskVersionMismatchError(taskId);
  }
}

export function adminClaimTask(
  db: PolymerDatabase,
  taskId: string,
  actorSessionId: string,
  leaseDurationSeconds: number = TASK_LEASE_DEFAULT_SECONDS,
): ClaimTaskResult {
  if (!Number.isInteger(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
    throw new Error("lease_duration_seconds must be a positive integer");
  }
  const write = db.transaction(() => {
    const task = getTask(db, taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    // done is terminal even for force (transition table).
    if (task.status === "done") {
      throw new TaskInvalidStatusError(task.status);
    }
    const before = auditSnapshot(task);
    const version = task.version + 1;
    const leaseGeneration = task.lease_generation + 1;
    const leaseExpiresAt = new Date(
      Date.now() + leaseDurationSeconds * 1000,
    ).toISOString();
    const now = new Date().toISOString();
    const updated = db
      .prepare(
        `UPDATE tasks SET status = 'in_progress', version = ?,
            lease_expires_at = ?, lease_generation = ?, updated_at = ?
          WHERE task_id = ? AND version = ?`,
      )
      .run(
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
    const after = auditSnapshot({
      status: "in_progress",
      coordinator: task.coordinator,
      version,
      lease_generation: leaseGeneration,
      lease_expires_at: leaseExpiresAt,
    });
    recordAudit(db, {
      actor_type: "admin_session",
      actor_id: actorSessionId,
      action: "task.claim.bypass",
      task_id: task.task_id,
      before,
      after,
    });
    return {
      task_id: task.task_id,
      title: task.title,
      status: "in_progress" as const,
      // A lease reset, not an ownership change: coordinator preserved.
      coordinator: task.coordinator,
      version,
      lease_expires_at: leaseExpiresAt,
      lease_generation: leaseGeneration,
    };
  });
  return write.immediate();
}

/**
 * Component 19: PATCH /api/tasks/:id — the admin variant of
 * update_task_status. `force: false` validates the carried fences
 * (expected_version + lease_generation as they read) and applies the
 * same transition table as the MCP tool; `force: true` skips lease,
 * fencing, and version checks but never the transition table, and
 * bumps version AND generation. Entering done/failed clears the lease
 * on either path. Audit row only for the force bypass.
 */
export interface AdminStatusResult {
  task_id: string;
  status: TaskStatus;
  version: number;
  updated_at: string;
}

export function adminUpdateTaskStatus(
  db: PolymerDatabase,
  taskId: string,
  actorSessionId: string,
  status: TaskStatus,
  force: boolean,
  leaseGeneration: number,
  expectedVersion: number,
): AdminStatusResult {
  ensureInt(leaseGeneration, taskId);
  ensureInt(expectedVersion, taskId);
  const write = db.transaction(() => {
    const task = getTask(db, taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (!force) {
      if (
        task.version !== expectedVersion ||
        task.lease_generation !== leaseGeneration
      ) {
        throw new TaskVersionMismatchError(task.task_id);
      }
    }
    assertTaskTransition(task.status, status);
    const before = auditSnapshot(task);
    const version = task.version + 1;
    const leaseGeneration1 = force
      ? task.lease_generation + 1
      : task.lease_generation;
    const now = new Date().toISOString();
    const clearsLease = status === "done" || status === "failed";
    const leaseExpiresAt = clearsLease ? null : task.lease_expires_at;
    const updated = db
      .prepare(
        `UPDATE tasks SET status = ?, version = ?,
            lease_expires_at = ?, lease_generation = ?, updated_at = ?
          WHERE task_id = ? AND version = ?`,
      )
      .run(
        status,
        version,
        leaseExpiresAt,
        leaseGeneration1,
        now,
        task.task_id,
        task.version,
      );
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    if (force) {
      recordAudit(db, {
        actor_type: "admin_session",
        actor_id: actorSessionId,
        action: "task.status.bypass",
        task_id: task.task_id,
        before,
        after: auditSnapshot({
          status,
          coordinator: task.coordinator,
          version,
          lease_generation: leaseGeneration1,
          lease_expires_at: leaseExpiresAt,
        }),
      });
    }
    return { task_id: task.task_id, status, version, updated_at: now };
  });
  return write.immediate();
}

/**
 * Component 19: POST /api/tasks/:id/assign — admin assignment.
 * Normal path validates the carried fences against the row (a NULL
 * lease never blocks: fencing works over the generation alone, per
 * the COALESCE rule) and bumps version only; `force: true` skips the
 * fences and bumps version AND generation. Existence and
 * already-assigned checks match the MCP tool under both paths.
 */
export function adminAssignTask(
  db: PolymerDatabase,
  taskId: string,
  actorSessionId: string,
  agentIds: string[],
  force: boolean,
  leaseGeneration: number,
  expectedVersion: number,
): AssignTaskResult {
  ensureInt(leaseGeneration, taskId);
  ensureInt(expectedVersion, taskId);
  const write = db.transaction(() => {
    const task = getTask(db, taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (!force) {
      if (
        task.version !== expectedVersion ||
        task.lease_generation !== leaseGeneration
      ) {
        throw new TaskVersionMismatchError(task.task_id);
      }
    }
    const targets = [...new Set(agentIds)];
    const existing = listTaskAssignees(db, taskId);
    for (const agentId of targets) {
      if (getAgentById(db, agentId) === undefined) {
        throw new TaskAgentNotFoundError(agentId);
      }
      if (existing.some((x) => x.agent_id === agentId)) {
        throw new TaskAlreadyAssignedError(task.task_id, agentId);
      }
    }
    const before = auditSnapshot(task);
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO task_assignments (task_id, agent_id, assigned_at) VALUES (?, ?, ?)",
    );
    for (const agentId of targets) {
      insert.run(task.task_id, agentId, now);
    }
    const version = task.version + 1;
    const leaseGeneration1 = force
      ? task.lease_generation + 1
      : task.lease_generation;
    const updated = db
      .prepare(
        "UPDATE tasks SET version = ?, lease_generation = ?, updated_at = ? WHERE task_id = ? AND version = ?",
      )
      .run(version, leaseGeneration1, now, task.task_id, task.version);
    if (updated.changes !== 1) {
      throw new TaskVersionMismatchError(task.task_id);
    }
    if (force) {
      recordAudit(db, {
        actor_type: "admin_session",
        actor_id: actorSessionId,
        action: "task.assign.bypass",
        task_id: task.task_id,
        before,
        after: auditSnapshot({
          status: task.status,
          coordinator: task.coordinator,
          version,
          lease_generation: leaseGeneration1,
          lease_expires_at: task.lease_expires_at,
        }),
      });
    }
    return {
      task_id: task.task_id,
      assigned_to: listTaskAssignees(db, task.task_id).map((a) => a.agent_id),
      version,
      lease_generation: leaseGeneration1,
      updated_at: now,
    };
  });
  return write.immediate();
}

/**
 * Component 19: POST /api/tasks/:id/transfer-coordinator — admin
 * handoff. Normal path validates the fences and a live lease;
 * `force: true` needs no live lease. Both bump version AND generation
 * (a transfer is an ownership-epoch change, like the MCP tool) and
 * renew the lease; force additionally writes the audit row. The
 * target must hold an assignment row on either path.
 */
export function adminTransferCoordinator(
  db: PolymerDatabase,
  taskId: string,
  actorSessionId: string,
  newCoordinatorId: string,
  force: boolean,
  leaseGeneration: number,
  expectedVersion: number,
  leaseDurationSeconds: number = TASK_LEASE_DEFAULT_SECONDS,
): TransferCoordinatorResult {
  ensureInt(leaseGeneration, taskId);
  ensureInt(expectedVersion, taskId);
  if (!Number.isInteger(leaseDurationSeconds) || leaseDurationSeconds <= 0) {
    throw new Error("lease_duration_seconds must be a positive integer");
  }
  const write = db.transaction(() => {
    const task = getTask(db, taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (!force) {
      const now = new Date().toISOString();
      const live =
        task.lease_expires_at !== null && task.lease_expires_at > now;
      if (!live) {
        // A dead lease is exactly what force exists for.
        throw new TaskAlreadyClaimedError(task.task_id);
      }
      if (
        task.version !== expectedVersion ||
        task.lease_generation !== leaseGeneration
      ) {
        throw new TaskVersionMismatchError(task.task_id);
      }
    }
    if (getAgentById(db, newCoordinatorId) === undefined) {
      throw new TaskAgentNotFoundError(newCoordinatorId);
    }
    if (
      listTaskAssignees(db, taskId).some(
        (a) => a.agent_id === newCoordinatorId,
      ) === false
    ) {
      throw new TaskNotAssignedError(task.task_id, newCoordinatorId);
    }
    const before = auditSnapshot(task);
    const version = task.version + 1;
    // A transfer is an ownership-epoch change on either path — the
    // MCP tool bumps unconditionally, and the admin normal path
    // validates fences exactly like the tool.
    const leaseGeneration1 = task.lease_generation + 1;
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(
      Date.now() + leaseDurationSeconds * 1000,
    ).toISOString();
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
    if (force) {
      recordAudit(db, {
        actor_type: "admin_session",
        actor_id: actorSessionId,
        action: "task.transfer.bypass",
        task_id: task.task_id,
        before,
        after: auditSnapshot({
          status: task.status,
          coordinator: newCoordinatorId,
          version,
          lease_generation: leaseGeneration1,
          lease_expires_at: leaseExpiresAt,
        }),
      });
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
  return write.immediate();
}
