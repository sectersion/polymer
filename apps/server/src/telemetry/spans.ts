import type { PolymerDatabase } from "../database/db.js";
import type { OtelAttribute } from "./otlp.js";

/**
 * Component 24: stored-span reads. The writer (queue.ts) is the only
 * mutation path; these readers serve tests now and trace correlation
 * (25) plus telemetry queries (27) later. Rows round-trip exactly:
 * JSON columns parse back to the shapes the parser produced.
 */
export interface StoredSpan {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  statusCode: number;
  statusMessage: string | null;
  attributes: OtelAttribute[];
  resourceAttributes: OtelAttribute[];
  scope: { name: string; version: string };
  agentId: string;
  ingestedAt: string;
}

const SPAN_COLUMNS = `span_id, trace_id, parent_span_id, name, kind,
  start_time_unix_ns, end_time_unix_ns, status_code, status_message,
  attributes, resource_attributes, scope, agent_id, ingested_at`;

function toStoredSpan(row: Record<string, unknown>): StoredSpan {
  return {
    spanId: row["span_id"] as string,
    traceId: row["trace_id"] as string,
    parentSpanId: (row["parent_span_id"] as string | null) ?? null,
    name: row["name"] as string,
    kind: row["kind"] as number,
    startTimeUnixNano: row["start_time_unix_ns"] as string,
    endTimeUnixNano: row["end_time_unix_ns"] as string,
    statusCode: row["status_code"] as number,
    statusMessage: (row["status_message"] as string | null) ?? null,
    attributes: JSON.parse(row["attributes"] as string) as OtelAttribute[],
    resourceAttributes: JSON.parse(
      row["resource_attributes"] as string,
    ) as OtelAttribute[],
    scope: JSON.parse(row["scope"] as string) as {
      name: string;
      version: string;
    },
    agentId: row["agent_id"] as string,
    ingestedAt: row["ingested_at"] as string,
  };
}

/** Every span of one trace, oldest first (rowid breaks timestamp ties). */
export function listSpansByTrace(
  db: PolymerDatabase,
  traceId: string,
): StoredSpan[] {
  const rows = db
    .prepare(
      `SELECT ${SPAN_COLUMNS} FROM otel_spans
        WHERE trace_id = ?
        ORDER BY start_time_unix_ns ASC, rowid ASC`,
    )
    .all(traceId) as Record<string, unknown>[];
  return rows.map(toStoredSpan);
}
