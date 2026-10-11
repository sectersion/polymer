import type { PolymerDatabase } from "../database/db.js";
import { catalogError } from "../tasks/store.js";

/**
 * Component 28: telemetry retention.
 *
 * Independent policies: telemetry (`otel_spans` by `ingested_at`,
 * `usage_records` by `recorded_at`) is pruned past `retentionDays`
 * (default 7); coordination history (agents, tasks, comments, audit,
 * …) is retained indefinitely and this job never touches it.
 * `telemetry_counters` are cumulative and survive retention — pruning
 * must not rewrite history the summaries already consumed.
 *
 * Bounded: at most 500 rows per table per transaction (the
 * single-writer rule), looping until nothing eligible remains or
 * `maxIterations` caps the run. Freed pages rejoin SQLite's freelist
 * for reuse, which bounds growth; no VACUUM (whole-file rewrite under
 * an exclusive lock has no place on the coordination writer's path).
 * Rows exactly at the cutoff are kept (`<`, never `<=`).
 */

export const DEFAULT_RETENTION_DAYS = 7;
/** Max rows deleted per table per transaction (single-writer rule). */
export const RETENTION_BATCH_ROWS = 500;
const DAY_MS = 24 * 3600 * 1000;

export interface RetentionOptions {
  retentionDays?: number;
  /** Bound on loop iterations per run (each ≤500 rows/table). */
  maxIterations?: number;
  /** Clock hook for deterministic tests. */
  nowMs?: number;
}

export interface RetentionResult {
  spansDeleted: number;
  usageDeleted: number;
  iterations: number;
  /** True when the iteration cap stopped the run early. */
  truncated: boolean;
}

export function runTelemetryRetention(
  db: PolymerDatabase,
  options: RetentionOptions = {},
): RetentionResult {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays <= 0 ||
    retentionDays > 36600
  ) {
    throw catalogError("invalid_request");
  }
  const maxIterations = options.maxIterations ?? 100;
  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw catalogError("invalid_request");
  }
  const cutoff = new Date(
    (options.nowMs ?? Date.now()) - retentionDays * DAY_MS,
  ).toISOString();

  const deleteSpans = db.prepare(
    `DELETE FROM otel_spans WHERE rowid IN
       (SELECT rowid FROM otel_spans WHERE ingested_at < ? LIMIT ?)`,
  );
  const deleteUsage = db.prepare(
    `DELETE FROM usage_records WHERE rowid IN
       (SELECT rowid FROM usage_records WHERE recorded_at < ? LIMIT ?)`,
  );
  const result: RetentionResult = {
    spansDeleted: 0,
    usageDeleted: 0,
    iterations: 0,
    truncated: false,
  };
  const stepSpans = db.transaction(() => {
    const spans = deleteSpans.run(cutoff, RETENTION_BATCH_ROWS);
    result.spansDeleted += Number(spans.changes);
    return spans.changes !== 0;
  });
  const stepUsage = db.transaction(() => {
    const usage = deleteUsage.run(cutoff, RETENTION_BATCH_ROWS);
    result.usageDeleted += Number(usage.changes);
    return usage.changes !== 0;
  });
  for (let i = 0; i < maxIterations; i += 1) {
    result.iterations += 1;
    const moreSpans = stepSpans();
    const moreUsage = stepUsage();
    if (!moreSpans && !moreUsage) return result;
  }
  result.truncated = true;
  return result;
}
