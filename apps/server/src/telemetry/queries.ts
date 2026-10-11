import type { PolymerDatabase } from "../database/db.js";
import { catalogError } from "../tasks/store.js";

/**
 * Component 27: fleet telemetry reads. Pure service layer — the HTTP
 * glue lives in ../http/telemetry.ts (route ownership: 27 owns
 * `GET /api/telemetry/*`). Coordination counts come from coordination
 * tables, token/cost aggregates from usage_records (component 26);
 * raw spans are never touched.
 *
 * Time handling: `recorded_at` is fixed-width ISO-8601 UTC, so range
 * predicates compare as strings. Bounds arrive as ISO-8601 UTC;
 * `from` is inclusive, `to` exclusive; the default window is the last
 * 24h and anything past 31 days is `invalid_request`.
 */

const DAY_MS = 24 * 3600 * 1000;
const MAX_RANGE_MS = 31 * DAY_MS;

function fail(code: string): never {
  throw catalogError(code);
}

/** JSON cannot serialize BigInt: past-2^53 sums normalize to Number. */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "bigint" ? Number(value) : (value as number);
}

export interface TelemetrySummary {
  total_comments: number;
  total_tasks: number;
  active_agents: number;
  total_tokens_used: number;
  total_cost_micro_usd: number;
}

export function getTelemetrySummary(db: PolymerDatabase): TelemetrySummary {
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM comments) AS total_comments,
              (SELECT COUNT(*) FROM tasks) AS total_tasks,
              (SELECT COUNT(*) FROM agents
                WHERE status NOT IN ('disabled', 'disconnected')) AS active_agents,
              (SELECT COALESCE(SUM(input_tokens), 0)
                     + COALESCE(SUM(output_tokens), 0)
                 FROM usage_records) AS total_tokens_used,
              (SELECT COALESCE(SUM(reported_cost_micro_usd), 0)
                 FROM usage_records) AS total_cost_micro_usd`,
    )
    .get() as Record<string, number | bigint>;
  return {
    total_comments: num(row["total_comments"]) ?? 0,
    total_tasks: num(row["total_tasks"]) ?? 0,
    active_agents: num(row["active_agents"]) ?? 0,
    total_tokens_used: num(row["total_tokens_used"]) ?? 0,
    total_cost_micro_usd: num(row["total_cost_micro_usd"]) ?? 0,
  };
}

export interface AgentTelemetry {
  agent_id: string;
  name: string;
  comments_sent: number;
  tasks_created: number;
  tokens_used: number;
  cost_micro_usd: number;
}

export function listAgentTelemetry(db: PolymerDatabase): {
  agents: AgentTelemetry[];
} {
  const rows = db
    .prepare(
      `SELECT a.agent_id, a.name,
              (SELECT COUNT(*) FROM comments c
                WHERE c.sender_agent_id = a.agent_id) AS comments_sent,
              (SELECT COUNT(*) FROM tasks t
                WHERE t.created_by = a.agent_id) AS tasks_created,
              (SELECT COALESCE(SUM(u.input_tokens), 0)
                     + COALESCE(SUM(u.output_tokens), 0)
                 FROM usage_records u
                WHERE u.agent_id = a.agent_id) AS tokens_used,
              (SELECT COALESCE(SUM(u.reported_cost_micro_usd), 0)
                 FROM usage_records u
                WHERE u.agent_id = a.agent_id) AS cost_micro_usd
         FROM agents a ORDER BY a.rowid ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return {
    agents: rows.map((row) => ({
      agent_id: row["agent_id"] as string,
      name: row["name"] as string,
      comments_sent: num(row["comments_sent"]) ?? 0,
      tasks_created: num(row["tasks_created"]) ?? 0,
      tokens_used: num(row["tokens_used"]) ?? 0,
      cost_micro_usd: num(row["cost_micro_usd"]) ?? 0,
    })),
  };
}

export interface TimeRange {
  from: string;
  to: string;
}

/** Parse ?from=&to= into comparable ISO bounds (defaults: last 24h). */
export function parseTimeRange(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  nowMs: number = Date.now(),
): TimeRange {
  const toMs = toRaw === undefined ? nowMs : Date.parse(toRaw);
  const fromMs = fromRaw === undefined ? toMs - DAY_MS : Date.parse(fromRaw);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    fail("invalid_request");
  }
  if (fromMs > toMs || toMs - fromMs > MAX_RANGE_MS) fail("invalid_request");
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

export interface TimelineEvent {
  usage_id: string;
  agent_id: string;
  task_id: string | null;
  trace_id: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  other_token_categories: Record<string, number> | null;
  reported_cost_micro_usd: number | null;
  cost_source: "reported" | "unknown";
  recorded_at: string;
}

/**
 * Opaque timeline cursor: the last row's (recorded_at, rowid).
 * Rowid-only cursors would misorder backdated inserts; this keeps
 * pages exactly chronological. Tampering answers `invalid_cursor`.
 */
function encodeTimelineCursor(recordedAt: string, rowid: number): string {
  return Buffer.from(
    JSON.stringify({ t: recordedAt, r: rowid }),
    "utf8",
  ).toString("base64url");
}

function decodeTimelineCursor(cursor: string): {
  recordedAt: string;
  rowid: number;
} {
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { t?: unknown; r?: unknown };
    if (
      typeof raw.t !== "string" ||
      typeof raw.r !== "number" ||
      !Number.isInteger(raw.r) ||
      raw.r < 0
    ) {
      fail("invalid_cursor");
    }
    return { recordedAt: raw.t, rowid: raw.r };
  } catch (err) {
    if ((err as { code?: string }).code === "invalid_cursor") throw err;
    fail("invalid_cursor");
  }
  throw new Error("unreachable");
}

export interface TimelineInput {
  from?: string;
  to?: string;
  agentId?: string;
  limit?: number;
  cursor?: string;
}

export function listTimeline(
  db: PolymerDatabase,
  input: TimelineInput,
): { events: TimelineEvent[]; next_cursor: string | null } {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    fail("invalid_request");
  }
  const range = parseTimeRange(input.from, input.to);
  const params: unknown[] = [range.from, range.to];
  let cursorSql = "";
  if (input.cursor !== undefined) {
    const cursor = decodeTimelineCursor(input.cursor);
    cursorSql = "AND (recorded_at > ? OR (recorded_at = ? AND rowid > ?))";
    params.push(cursor.recordedAt, cursor.recordedAt, cursor.rowid);
  }
  let agentSql = "";
  if (input.agentId !== undefined) {
    agentSql = "AND agent_id = ?";
    params.push(input.agentId);
  }
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, usage_id, agent_id, task_id, trace_id,
              provider, model, input_tokens, output_tokens,
              other_token_categories, reported_cost_micro_usd,
              cost_source, recorded_at
         FROM usage_records
        WHERE recorded_at >= ? AND recorded_at < ?
        ${cursorSql} ${agentSql}
        ORDER BY recorded_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<
    Record<string, unknown> & { _rowid: number }
  >;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: page.map(toTimelineEvent),
    next_cursor:
      hasMore && page.length > 0
        ? encodeTimelineCursor(
            page[page.length - 1]["recorded_at"] as string,
            page[page.length - 1]._rowid,
          )
        : null,
  };
}

function toTimelineEvent(row: Record<string, unknown>): TimelineEvent {
  let other: Record<string, number> | null = null;
  const rawOther = row["other_token_categories"];
  if (typeof rawOther === "string") {
    try {
      other = JSON.parse(rawOther) as Record<string, number>;
    } catch {
      other = null;
    }
  }
  const costSource = row["cost_source"];
  return {
    usage_id: row["usage_id"] as string,
    agent_id: row["agent_id"] as string,
    task_id: (row["task_id"] as string | null) ?? null,
    trace_id: (row["trace_id"] as string | null) ?? null,
    provider: (row["provider"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    input_tokens: num(row["input_tokens"]),
    output_tokens: num(row["output_tokens"]),
    other_token_categories: other,
    reported_cost_micro_usd: num(row["reported_cost_micro_usd"]),
    cost_source: costSource === "reported" ? "reported" : "unknown",
    recorded_at: row["recorded_at"] as string,
  };
}

export type CostGranularity = "hourly" | "daily";

export interface CostsInput {
  granularity: string | undefined;
  from?: string;
  to?: string;
}

export interface CostBucket {
  bucket_start: string;
  cost_micro_usd: number;
}

export function getCosts(
  db: PolymerDatabase,
  input: CostsInput,
): { time_series: CostBucket[] } {
  if (input.granularity !== "hourly" && input.granularity !== "daily") {
    fail("invalid_request");
  }
  const granularity = input.granularity as CostGranularity;
  const range = parseTimeRange(input.from, input.to);
  const bucketExpr =
    granularity === "hourly"
      ? "strftime('%Y-%m-%dT%H:00:00.000Z', recorded_at)"
      : "strftime('%Y-%m-%dT00:00:00.000Z', recorded_at)";
  const rows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              COALESCE(SUM(reported_cost_micro_usd), 0) AS cost
         FROM usage_records
        WHERE recorded_at >= ? AND recorded_at < ?
        GROUP BY bucket`,
    )
    .all(range.from, range.to) as Array<{
    bucket: string;
    cost: number | bigint;
  }>;
  const known = new Map(rows.map((r) => [r.bucket, num(r.cost) ?? 0]));
  // Zero-fill from the floored bound: every aligned bucket in
  // [floor(from), to) appears, even with no usage behind it.
  const stepMs = granularity === "hourly" ? 3600_000 : DAY_MS;
  const startMs = floorUtc(Date.parse(range.from), granularity);
  const endMs = Date.parse(range.to);
  const time_series: CostBucket[] = [];
  for (let at = startMs; at < endMs; at += stepMs) {
    const bucket_start = new Date(at).toISOString();
    time_series.push({
      bucket_start,
      cost_micro_usd: known.get(bucket_start) ?? 0,
    });
  }
  return { time_series };
}

/** Floor a timestamp to the UTC hour/day boundary. */
function floorUtc(ms: number, granularity: CostGranularity): number {
  const d = new Date(ms);
  if (granularity === "hourly") {
    return Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
    );
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
