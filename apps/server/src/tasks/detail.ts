import type { PolymerDatabase } from "../database/db.js";
import { getTask, listTaskAssignees, type Task } from "./store.js";
import {
  DETAIL_EMBEDDED_COMMENTS,
  latestComments,
  type Comment,
} from "./comments.js";

/**
 * The exact list-item serialization shared by MCP get_tasks and
 * REST /api/tasks — one function, so the two surfaces cannot drift.
 */
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

export interface TaskDetail {
  task: Task;
  assigneeIds: string[];
  /** The newest embedded window + whether full history continues. */
  comments: { comments: Comment[]; has_more: boolean };
}

/**
 * Component 18: the complete detail read behind BOTH surfaces —
 * one read transaction, one snapshot (components f3a7f50's rule),
 * so a concurrent writer cannot tear the composite.
 */
export function getTaskDetail(
  db: PolymerDatabase,
  taskId: string,
): TaskDetail | undefined {
  const detail = db.transaction(() => {
    const task = getTask(db, taskId);
    if (task === undefined) return undefined;
    return {
      task,
      assigneeIds: listTaskAssignees(db, task.task_id).map((a) => a.agent_id),
      comments: latestComments(db, task.task_id, DETAIL_EMBEDDED_COMMENTS),
    };
  })();
  return detail;
}

/** The exact 15-key detail serialization shared by MCP and REST. */
export function serializeTaskDetail(detail: TaskDetail) {
  const { task, assigneeIds, comments } = detail;
  return {
    task_id: task.task_id,
    title: task.title,
    description: task.description,
    status: task.status,
    version: task.version,
    created_by: task.created_by,
    coordinator: task.coordinator,
    lease_generation: task.lease_generation,
    lease_expires_at: task.lease_expires_at,
    trace_parent: task.trace_parent,
    assigned_to: assigneeIds,
    comments: comments.comments,
    has_more: comments.has_more,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}
