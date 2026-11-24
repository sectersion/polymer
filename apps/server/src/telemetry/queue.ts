import type { PolymerDatabase } from "../database/db.js";
import { usageEventId, type UsageEvent } from "./logs.js";
import type { ValidatedSpan } from "./otlp.js";
import {
  TASK_ID_ATTRIBUTE,
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
 * spans (enforced at validation), and at most `maxBytes` of request
 * body bytes across all queued batches. The byte count is WIRE bytes
 * (decoded heap is several times larger), so the real worst case is a
 * multiple of `maxBytes`. Memory cannot grow without bound.
 * The writer and the queue share the event loop with coordination
 * traffic; flushes are single transactions and the timer never
 * overlaps itself.
 */

export interface QueuedBatch {
  agentId: string;
  spans: ValidatedSpan[];
  /** Usage events from an OTLP logs batch (#159); written after the spans. */
  usage?: UsageEvent[];
  receivedAt: string;
  /** Request body length this batch was decoded from (wire bytes). */
  bytes: number;
}

/** Default queue byte budget: 64 MiB of wire bytes. */
export const DEFAULT_QUEUE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Maximum rows per writer transaction (skill bound). A full queue
 * (100 batches × 500 spans) flushes as up to 100 sequential
 * transactions — never one giant one — so a flush neither starves
 * coordination nor risks an unbounded journal.
 */
const MAX_ROWS_PER_TXN = 500;

/** Spans dropped after repeated deterministic flush failures. */
export const DROPPED_SPANS_COUNTER = "telemetry.flush_dropped_spans";
const MAX_DETERMINISTIC_ATTEMPTS = 3;

/** Transient SQLite failures are retried forever, never dropped. */
function isTransientSqliteError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    /^SQLITE_(BUSY|LOCKED|FULL|IOERR|CANTOPEN)/.test(code)
  );
}

type Row =
  | { agentId: string; span: ValidatedSpan; receivedAt: string }
  | { agentId: string; event: UsageEvent; receivedAt: string };

/** Rows a batch still holds: its spans, then its usage events. */
const batchSize = (b: QueuedBatch): number =>
  b.spans.length + (b.usage?.length ?? 0);

export interface TelemetryQueueOptions {
  maxBatches: number;
  /** Wire-byte budget across queued batches; finite and > 0. */
  maxBytes?: number;
  flushMs: number;
}

export class TelemetryQueue {
  private readonly pending: QueuedBatch[] = [];
  private readonly maxBytes: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing = false;
  private failedAttempts = 0;
  private unrecordedDrops = 0;
  private counterBump: { run(...args: unknown[]): unknown } | undefined;

  constructor(
    private readonly db: PolymerDatabase | null,
    private readonly options: TelemetryQueueOptions,
  ) {
    const maxBytes = options.maxBytes ?? DEFAULT_QUEUE_MAX_BYTES;
    // Nonsense is refused, never read as "unlimited".
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new RangeError("telemetry queue maxBytes must be finite and > 0");
    }
    this.maxBytes = maxBytes;
  }

  /** Start the periodic flush. Idempotent. */
  start(): void {
    if (this.timer !== undefined || this.db === null) return;
    this.timer = setInterval(() => {
      try {
        this.flush();
      } catch (err) {
        // A failed flush must never take down the server (or wedge
        // the timer): the failing chunk and everything after it stay
        // queued for the next tick, and the failure is visible in
        // logs, never in client responses.
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
   * Wire bytes currently queued. Derived from `pending` (at most
   * maxBatches entries) rather than tracked in a counter, so it cannot
   * drift or leak across drains, drops, or partial batches.
   */
  queuedBytes(): number {
    let total = 0;
    for (const batch of this.pending) total += batch.bytes;
    return total;
  }

  /**
   * Accept one validated batch. Returns false when the queue is full
   * by batch count or byte budget (caller answers 429 + retry_after)
   * or when there is no database to drain into; true means validated
   * and queued — never committed.
   */
  enqueue(batch: QueuedBatch): boolean {
    if (this.db === null) return false;
    if (this.pending.length >= this.options.maxBatches) return false;
    if (this.queuedBytes() + batch.bytes > this.maxBytes) return false;
    this.pending.push(batch);
    return true;
  }

  /**
   * Write every queued batch, chunked into transactions of at most
   * 500 rows. Returns the number of span rows written. Re-entrant
   * calls are skipped (the timer never overlaps itself; a manual
   * flush during a timer flush is a no-op returning 0).
   *
   * A chunk leaves `pending` only after its transaction commits, so
   * a throw leaves the failing chunk and everything after it queued
   * (flush rethrows; the timer logs and retries next tick). Failures
   * are classified: transient SQLite errors (busy, locked, full, I/O,
   * cantopen) are retried forever, never dropped; the full queue's
   * 429 is the backpressure. Any other error is deterministic: after
   * MAX_DETERMINISTIC_ATTEMPTS consecutive failures that chunk is
   * dropped and counted in DROPPED_SPANS_COUNTER, so one poison span
   * cannot wedge intake.
   *
   * SQLITE_BUSY needs no app-level retry here: the database sets
   * `PRAGMA busy_timeout = 5000`, so SQLite backs off and retries
   * internally. Duplicate span_ids collapse via INSERT OR IGNORE: an
   * OTLP retry of an already-flushed batch is idempotent. (OR IGNORE
   * does NOT cover a foreign-key failure, e.g. a vanished agent row:
   * that throws and takes the deterministic-failure path above.)
   */
  flush(): number {
    if (this.db === null || this.flushing) return 0;
    if (this.pending.length === 0) {
      // A drop count whose counter write failed must not be stranded
      // by an empty queue.
      this.recordDrops();
      return 0;
    }
    this.flushing = true;
    try {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO otel_spans
           (span_id, trace_id, agent_id, name, parent_span_id,
            start_time_unix_ns, end_time_unix_ns, kind, status_code,
            status_message, attributes, resource_attributes, scope,
            ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
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
      // Log-derived usage only: a deterministic usage_id makes an
      // exporter retry idempotent (OR IGNORE). Never used for spans.
      const logUsageInsert = this.db.prepare(
        `INSERT OR IGNORE INTO usage_records
           (usage_id, agent_id, task_id, trace_id, provider, model,
            input_tokens, output_tokens, other_token_categories,
            reported_cost_micro_usd, cost_source, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const counterBump = this.db.prepare(
        `INSERT INTO telemetry_counters (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`,
      );
      this.counterBump = counterBump;
      // Per-chunk accounting lives inside the closure: a rolled-back
      // transaction must not leave partial counts behind.
      const writeChunk = this.db.transaction((chunk: Row[]) => {
        let chunkWritten = 0;
        let rejectedClaims = 0;
        for (const row of chunk) {
          if ("event" in row) {
            const e = row.event;
            const other: Record<string, number> = {};
            if (typeof e.cacheReadTokens === "number") {
              other["cache_read_tokens"] = e.cacheReadTokens;
            }
            if (typeof e.cacheCreationTokens === "number") {
              other["cache_creation_tokens"] = e.cacheCreationTokens;
            }
            // The claim goes through resolveUsageTask UNCHANGED (wrapped as
            // the span attribute it reads): honored only for a task this
            // agent coordinates or is assigned to. A malformed claim is
            // rejected without being stored or echoed.
            let claimedTask: string | null = null;
            let claimRejected = e.taskClaimMalformed;
            if (e.taskClaim !== null) {
              const resolved = resolveUsageTask(this.db!, row.agentId, {
                attributes: [
                  {
                    key: TASK_ID_ATTRIBUTE,
                    value: { stringValue: e.taskClaim },
                  },
                ],
              } as ValidatedSpan);
              claimedTask = resolved.taskId;
              claimRejected = resolved.rejected;
            }
            const r = logUsageInsert.run(
              usageEventId(row.agentId, e),
              row.agentId,
              claimedTask,
              null,
              "anthropic",
              e.model,
              e.inputTokens,
              e.outputTokens,
              Object.keys(other).length > 0 ? JSON.stringify(other) : null,
              e.costMicroUsd,
              e.costMicroUsd === null ? "unknown" : "reported",
              row.receivedAt,
            );
            chunkWritten += Number(r.changes);
            // Per RECORD, and only for a row actually inserted (an
            // exporter retry of a stored event must not recount). The
            // local is per chunk, bumped inside this transaction, so a
            // rollback leaves no stale count.
            if (claimRejected && Number(r.changes) === 1) rejectedClaims += 1;
            continue;
          }
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
          chunkWritten += 1;
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
        }
        return chunkWritten;
      });
      let written = 0;
      while (this.pending.length > 0) {
        // Build the next chunk from the queue front WITHOUT removing it.
        const chunk: Row[] = [];
        let wholeBatches = 0;
        let usedInHead = 0;
        for (const batch of this.pending) {
          const take = Math.min(
            batchSize(batch),
            MAX_ROWS_PER_TXN - chunk.length,
          );
          for (let i = 0; i < take; i++) {
            chunk.push(
              i < batch.spans.length
                ? {
                    agentId: batch.agentId,
                    span: batch.spans[i]!,
                    receivedAt: batch.receivedAt,
                  }
                : {
                    agentId: batch.agentId,
                    event: batch.usage![i - batch.spans.length]!,
                    receivedAt: batch.receivedAt,
                  },
            );
          }
          if (take < batchSize(batch)) {
            usedInHead = take;
            break;
          }
          wholeBatches += 1;
          if (chunk.length >= MAX_ROWS_PER_TXN) break;
        }
        try {
          written += writeChunk(chunk);
        } catch (err) {
          if (isTransientSqliteError(err)) {
            this.failedAttempts = 0; // only consecutive deterministic failures count
            throw err;
          }
          this.failedAttempts += 1;
          if (this.failedAttempts < MAX_DETERMINISTIC_ATTEMPTS) throw err;
          // Counts + code only: never span contents.
          console.error("telemetry chunk dropped:", {
            spans: chunk.length,
            code: (err as { code?: unknown }).code ?? "unknown",
          });
          this.failedAttempts = 0;
          this.unrecordedDrops += chunk.length;
          this.dequeue(wholeBatches, usedInHead);
          this.recordDrops();
          continue;
        }
        this.failedAttempts = 0;
        this.dequeue(wholeBatches, usedInHead);
      }
      this.recordDrops();
      return written;
    } finally {
      this.flushing = false;
    }
  }

  /** Remove what a committed (or dropped) chunk consumed from the front. */
  private dequeue(wholeBatches: number, usedInHead: number): void {
    this.pending.splice(0, wholeBatches);
    if (usedInHead > 0) {
      const head = this.pending[0]!;
      const remaining = batchSize(head) - usedInHead;
      const fromSpans = Math.min(usedInHead, head.spans.length);
      // Prorate so the budget frees as the head drains. ceil may leave
      // up to a byte of slack per boundary; harmless because the total
      // is always recomputed from `pending`.
      this.pending[0] = {
        ...head,
        spans: head.spans.slice(fromSpans),
        usage: head.usage?.slice(usedInHead - fromSpans),
        bytes: Math.ceil((head.bytes * remaining) / batchSize(head)),
      };
    }
  }

  /**
   * Persist the drop count. Drops only happen while the database is
   * healthy, so this normally succeeds at once; if it does not, the
   * count stays in memory and is retried on the next flush.
   */
  private recordDrops(): void {
    if (this.unrecordedDrops === 0 || this.counterBump === undefined) return;
    try {
      this.counterBump.run(DROPPED_SPANS_COUNTER, this.unrecordedDrops);
      this.unrecordedDrops = 0;
    } catch (err) {
      console.error("telemetry drop counter write failed:", {
        spans: this.unrecordedDrops,
        code: (err as { code?: unknown }).code ?? "unknown",
      });
    }
  }
}
