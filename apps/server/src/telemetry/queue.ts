import type { PolymerDatabase } from "../database/db.js";
import type { ValidatedSpan } from "./otlp.js";
import {
  TASK_ID_REJECTED_COUNTER,
  deriveSpanUsage,
  resolveUsageTask,
} from "./usage.js";
import { randomUUID } from "node:crypto";

/**
 * Component 23: the bounded in-memory telemetry queue.
 *
 * Pipeline: OTLP receiver → validation → enqueue → (timer) flush →
 * SQLite. `enqueue` acknowledges validation only, never the commit:
 * a crash between the two loses the buffered batches (at-most-once
 * across crashes — the component-23 crash test asserts exactly this).
 * A full queue rejects with `false` so the HTTP layer answers 429.
 *
 * Bound: at most `maxBatches` batches, each at most `batchMaxSpans`
 * spans (enforced at validation). Memory cannot grow without bound.
 * The writer and the queue share the event loop with coordination
 * traffic; flushes are single transactions and the timer never
 * overlaps itself.
 */

export interface QueuedBatch {
  agentId: string;
  spans: ValidatedSpan[];
  receivedAt: string;
}

/**
 * Maximum rows per writer transaction (skill bound). A full queue
 * (100 batches × 500 spans) flushes as up to 100 sequential
 * transactions — never one giant one — so a flush neither starves
 * coordination nor risks an unbounded journal.
 */
const MAX_ROWS_PER_TXN = 500;

export interface TelemetryQueueOptions {
  maxBatches: number;
  flushMs: number;
}

export class TelemetryQueue {
  private readonly pending: QueuedBatch[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;

  constructor(
    private readonly db: PolymerDatabase | null,
    private readonly options: TelemetryQueueOptions,
  ) {}

  /** Start the periodic flush. Idempotent. */
  start(): void {
    if (this.timer !== undefined || this.db === null) return;
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch (err) {
        // A failed flush must never take down the server (or wedge
        // the timer): batches stay queued for the next tick, and the
        // failure is visible in logs, never in client responses.
        console.error("telemetry flush failed:", err);
      }
    }, this.options.flushMs);
    this.timer.unref?.();
  }

  /** Stop the timer. Buffered batches stay queued until flush(). */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  depth(): number {
    return this.pending.length;
  }

  /**
   * Accept one validated batch. Returns false when the queue is full
   * (caller answers 429 + retry_after) or when there is no database
   * to drain into; true means validated and queued — never committed.
   */
  enqueue(batch: QueuedBatch): boolean {
    if (this.db === null) return false;
    if (this.pending.length >= this.options.maxBatches) return false;
    this.pending.push(batch);
    return true;
  }

  /**
   * Write every queued batch, chunked into transactions of at most
   * 500 rows. Returns the number of span rows written. Re-entrant
   * calls are skipped (the timer never overlaps itself; a manual
   * flush during a timer flush is a no-op returning 0).
   *
   * SQLITE_BUSY needs no app-level retry here: the database sets
   * `PRAGMA busy_timeout = 5000`, so SQLite backs off and retries
   * internally. Duplicate span_ids collapse via INSERT OR IGNORE: an
   * OTLP retry of an already-flushed batch is idempotent. (The same
   * clause silently drops spans whose agent row vanished mid-queue —
   * consistent with at-most-once, never an error.)
   */
  flush(): number {
    if (this.db === null || this.flushing || this.pending.length === 0) {
      return 0;
    }
    this.flushing = true;
    try {
      const batches = this.pending.splice(0, this.pending.length);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO otel_spans
           (span_id, trace_id, agent_id, name, parent_span_id,
            start_time_unix_ns, end_time_unix_ns, kind, status_code,
            status_message, attributes, resource_attributes, scope,
            ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let written = 0;
      let chunk: Array<{
        agentId: string;
        span: ValidatedSpan;
        receivedAt: string;
      }> = [];
      // Component 26: usage rows derive in the SAME transaction as the
      // spans — never a separate ingestion path. Only spans actually
      // inserted (changes === 1) derive usage, so an OTLP retry of an
      // already-flushed batch stays idempotent for costs too. Rejected
      // task claims accumulate per chunk into one counter upsert.
      const usageInsert = this.db.prepare(
        `INSERT INTO usage_records
           (usage_id, agent_id, task_id, trace_id, provider, model,
            input_tokens, output_tokens, other_token_categories,
            reported_cost_micro_usd, cost_source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const counterBump = this.db.prepare(
        `INSERT INTO telemetry_counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      );
      let rejectedClaims = 0;
      const writeChunk = this.db.transaction(() => {
        for (const row of chunk) {
          const result = insert.run(
            row.span.spanId,
            row.span.traceId,
            row.agentId,
            row.span.name,
            row.span.parentSpanId,
            row.span.startTimeUnixNano,
            row.span.endTimeUnixNano,
            row.span.kind,
            row.span.statusCode,
            row.span.statusMessage,
            JSON.stringify(row.span.attributes),
            JSON.stringify(row.span.resourceAttributes),
            JSON.stringify(row.span.scope),
            row.receivedAt,
          );
          if (Number(result.changes) !== 1) continue;
          written += 1;
          const usage = deriveSpanUsage(row.span);
          if (!usage.hasUsage) continue;
          const task = resolveUsageTask(this.db!, row.agentId, row.span);
          if (task.rejected) rejectedClaims += 1;
          usageInsert.run(
            randomUUID(),
            row.agentId,
            task.taskId,
            row.span.traceId,
            usage.provider,
            usage.model,
            usage.inputTokens,
            usage.outputTokens,
            usage.otherTokenCategories === null
              ? null
              : JSON.stringify(usage.otherTokenCategories),
            usage.reportedCostMicroUsd,
            usage.costSource,
            row.receivedAt,
          );
        }
        if (rejectedClaims > 0) {
          counterBump.run(TASK_ID_REJECTED_COUNTER, rejectedClaims);
          rejectedClaims = 0;
        }
      });
      for (const batch of batches) {
        for (const span of batch.spans) {
          chunk.push({
            agentId: batch.agentId,
            span,
            receivedAt: batch.receivedAt,
          });
          if (chunk.length >= MAX_ROWS_PER_TXN) {
            writeChunk();
            chunk = [];
          }
        }
      }
      if (chunk.length > 0) {
        writeChunk();
      }
      return written;
    } finally {
      this.flushing = false;
    }
  }
}
