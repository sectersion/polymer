import type { PolymerDatabase } from "../database/db.js";
import { TASK_LEASE_DEFAULT_SECONDS, getTask, type Task } from "./store.js";
import {
  TaskAlreadyClaimedError,
  TaskInvalidStatusError,
  TaskNotFoundError,
  TaskUnauthorizedError,
  TaskVersionMismatchError,
} from "./errors.js";

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
