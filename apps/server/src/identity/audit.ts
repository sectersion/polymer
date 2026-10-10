import { randomUUID } from "node:crypto";
import type { PolymerDatabase } from "../database/db.js";
// The opaque cursor encoding is owned by the task store and shared by
// every list surface on purpose (no drift between REST lists).
import { encodeCursor, decodeCursor, catalogError } from "../tasks/store.js";

/**
 * Component 19: the AuditLog entity — one row per administrator
 * bypass/rotation action, written inside the SAME transaction as the
 * mutation. `before`/`after` are limited to task columns (status,
 * coordinator, version, generation, lease): never comment bodies,
 * never telemetry blobs, never credentials.
 */
export interface AuditLogRow {
  audit_id: string;
  actor_type: "admin_session" | "master" | "system";
  actor_id: string;
  action: string;
  task_id: string | null;
  before: string | null;
  after: string | null;
  created_at: string;
}

export interface AuditInput {
  actor_type: "admin_session" | "master" | "system";
  actor_id: string;
  action: string;
  task_id?: string | null;
  /** Task-column snapshot (status/coordinator/version/generation/lease). */
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}

const AUDIT_COLUMNS =
  "audit_id, actor_type, actor_id, action, task_id, before, after, created_at";

function toAuditRow(row: Record<string, unknown>): AuditLogRow {
  return {
    audit_id: row["audit_id"] as string,
    actor_type: row["actor_type"] as AuditLogRow["actor_type"],
    actor_id: row["actor_id"] as string,
    action: row["action"] as string,
    task_id: (row["task_id"] as string | null) ?? null,
    before: (row["before"] as string | null) ?? null,
    after: (row["after"] as string | null) ?? null,
    created_at: row["created_at"] as string,
  };
}

/**
 * Narrow snapshot helper: task columns only (never comment bodies or
 * other payload columns) — the logging rule the design fixes.
 */
export function taskAuditSnapshot(task: Record<string, unknown>) {
  return {
    status: task["status"] ?? null,
    coordinator: task["coordinator"] ?? null,
    version: task["version"] ?? null,
    lease_generation: task["lease_generation"] ?? null,
    lease_expires_at: task["lease_expires_at"] ?? null,
  };
}

export function recordAudit(
  db: PolymerDatabase,
  input: AuditInput,
): AuditLogRow {
  const row = db
    .prepare(
      `INSERT INTO audit_log
         (audit_id, actor_type, actor_id, action, task_id, before, after)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING ${AUDIT_COLUMNS}`,
    )
    .get(
      randomUUID(),
      input.actor_type,
      input.actor_id,
      input.action,
      input.task_id ?? null,
      input.before ? JSON.stringify(input.before) : null,
      input.after ? JSON.stringify(input.after) : null,
    ) as Record<string, unknown> | undefined;
  if (!row) throw new Error("audit insert returned no row");
  return toAuditRow(row);
}

export interface AuditPage {
  audits: AuditLogRow[];
  next_cursor: string | null;
}

/**
 * Component 19: `GET /api/audit?task_id=&limit=&cursor=` — newest
 * first, cursor-paginated with the same opaque rowid cursor as every
 * other list route.
 */
export function listAudit(
  db: PolymerDatabase,
  input: { taskId?: string; limit?: number; cursor?: string } = {},
): AuditPage {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw catalogError("invalid_request");
  }
  // Descending pagination: the cursor is the last row's rowid; the
  // first page starts from MAX_SAFE_INTEGER.
  const cursorRowid =
    input.cursor === undefined
      ? Number.MAX_SAFE_INTEGER
      : decodeCursor(input.cursor);
  const clauses = ["rowid < ?"];
  const params: unknown[] = [cursorRowid];
  if (input.taskId !== undefined) {
    clauses.push("task_id = ?");
    params.push(input.taskId);
  }
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, ${AUDIT_COLUMNS} FROM audit_log
        WHERE ${clauses.join(" AND ")}
        ORDER BY rowid DESC LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<
    Record<string, unknown> & { _rowid: number }
  >;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    audits: page.map(toAuditRow),
    next_cursor: hasMore ? encodeCursor(page[page.length - 1]._rowid) : null,
  };
}
