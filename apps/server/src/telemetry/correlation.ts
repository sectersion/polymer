import type { PolymerDatabase } from "../database/db.js";
import { getTask, type Task } from "../tasks/store.js";
import { listSpansByTrace, type StoredSpan } from "./spans.js";

/**
 * Component 25: task ↔ trace correlation.
 *
 * `Task.trace_parent` and `Comment.trace_parent` are stored opaque
 * (components 10/17 never validate them); this seam is where the W3C
 * Trace Context string is interpreted. Parsing is strict and total:
 * anything that is not a well-formed `version-traceid-parentid-flags`
 * header yields `null` (no correlated trace), never an error and never
 * a guessed trace id. Identity still comes from auth everywhere —
 * trace_parent only locates spans, it never authenticates.
 *
 * No new routes: task reads stay owned by 18/19 and telemetry queries
 * by 27. These readers serve tests now and the trace waterfall (which
 * is entered from a task's `trace_parent` link) later.
 */

export interface TraceContext {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

function isNonZeroHex(text: string): boolean {
  return /^[0-9a-f]+$/.test(text) && !/^0+$/.test(text);
}

/**
 * Parse one W3C traceparent header. Version `00` with exactly four
 * fields; ids must be the full width, lowercase-hex, non-zero.
 * Uppercase input is tolerated (lowercased before validation).
 */
export function parseTraceParent(value: unknown): TraceContext | null {
  if (typeof value !== "string") return null;
  const parts = value.toLowerCase().split("-");
  if (parts.length !== 4) return null;
  const [version, traceId, parentSpanId, flags] = parts;
  if (version !== "00") return null;
  if (traceId.length !== 32 || !isNonZeroHex(traceId)) return null;
  if (parentSpanId.length !== 16 || !isNonZeroHex(parentSpanId)) return null;
  if (flags.length !== 2 || !/^[0-9a-f]{2}$/.test(flags)) return null;
  return { traceId, parentSpanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

/** The trace a task points at, or null when it points at none. */
export function getTraceIdForTask(
  db: PolymerDatabase,
  taskId: string,
): string | null {
  const task = getTask(db, taskId);
  if (task === undefined) return null;
  return parseTraceParent(task.trace_parent)?.traceId ?? null;
}

/** Every stored span of the task's trace, oldest first; [] when none. */
export function listSpansForTask(
  db: PolymerDatabase,
  taskId: string,
): StoredSpan[] {
  const traceId = getTraceIdForTask(db, taskId);
  if (traceId === null) return [];
  return listSpansByTrace(db, traceId);
}

/** The trace a comment points at, or null when it points at none. */
export function getTraceIdForComment(
  db: PolymerDatabase,
  commentId: string,
): string | null {
  const row = db
    .prepare("SELECT trace_parent FROM comments WHERE comment_id = ?")
    .get(commentId) as { trace_parent: string | null } | undefined;
  if (row === undefined) return null;
  return parseTraceParent(row.trace_parent)?.traceId ?? null;
}

/** Every stored span of the comment's trace, oldest first; [] when none. */
export function listSpansForComment(
  db: PolymerDatabase,
  commentId: string,
): StoredSpan[] {
  const traceId = getTraceIdForComment(db, commentId);
  if (traceId === null) return [];
  return listSpansByTrace(db, traceId);
}

function isTraceId(value: string): boolean {
  return value.length === 32 && isNonZeroHex(value);
}

/**
 * Every task whose trace_parent resolves to `traceId`. Tasks with
 * missing or malformed trace_parent never match; a malformed traceId
 * matches nothing (never an error, so telemetry lookups cannot throw
 * on caller-supplied ids).
 */
export function listTasksForTrace(
  db: PolymerDatabase,
  traceId: string,
): Task[] {
  const needle = traceId.toLowerCase();
  if (!isTraceId(needle)) return [];
  const rows = db
    .prepare(
      `SELECT task_id, trace_parent FROM tasks
         WHERE trace_parent IS NOT NULL`,
    )
    .all() as Array<{ task_id: string; trace_parent: string | null }>;
  const out: Task[] = [];
  for (const row of rows) {
    if (parseTraceParent(row.trace_parent)?.traceId !== needle) continue;
    const task = getTask(db, row.task_id);
    if (task !== undefined) out.push(task);
  }
  return out;
}
