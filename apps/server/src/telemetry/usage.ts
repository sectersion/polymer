import type { PolymerDatabase } from "../database/db.js";
import type {
  OtelAttribute,
  OtelAttributeValue,
  ValidatedSpan,
} from "./otlp.js";

/**
 * Component 26: usage derivation and cost attribution.
 *
 * Usage rows are derived server-side from OTLP span attributes at
 * ingestion time, in the same batch transaction as the spans (see
 * queue.ts) — there is intentionally no `report_usage` tool. Money is
 * integer micro-USD everywhere, never binary floating-point: only the
 * `intValue` shape of the cost attribute is accepted, and a
 * `doubleValue` cost is ignored (NULL, `unknown`) rather than rounded.
 *
 * Contract decisions the design leaves open:
 * - Task claims arrive via the `polymer.task_id` span attribute
 *   (namespaced so future OTLP conventions cannot collide with it).
 * - One usage row per span carrying at least one of the five mapped
 *   `gen_ai.*` attributes (key presence triggers the row; unparseable
 *   values become NULL, never errors). A bare `polymer.task_id`
 *   without usage attributes yields no row and no rejection count.
 * - `task_id_rejected` increments only for claims carried by spans
 *   that produce a usage row: a non-empty task claim on an unknown
 *   task, or on a task the ingesting agent neither coordinates nor is
 *   assigned to. Telemetry can never claim work.
 * - Extra `gen_ai.usage.*` integer attributes land in
 *   `other_token_categories` (safe-range integers only, so the JSON
 *   column can never meet a BigInt it cannot serialize).
 *
 * Derivation is total: hostile attribute values (negatives, garbage
 * strings, out-of-range integers) sanitize to NULL. Telemetry input
 * must never abort a flush — usage_records carries no foreign keys
 * and no CHECKs on telemetry-controlled columns for exactly this
 * reason. `cost_source` is `reported` only when the cost attribute is
 * present AND parses; `"estimated"` is never emitted by the MVP.
 */

export const TASK_ID_ATTRIBUTE = "polymer.task_id";

const MODEL_ATTRIBUTE = "gen_ai.request.model";
const PROVIDER_ATTRIBUTE = "gen_ai.provider.name";
const INPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.output_tokens";
const COST_ATTRIBUTE = "gen_ai.usage.cost_micro_usd";
const USAGE_PREFIX = "gen_ai.usage.";

const MAPPED_USAGE_KEYS = new Set([
  MODEL_ATTRIBUTE,
  PROVIDER_ATTRIBUTE,
  INPUT_TOKENS_ATTRIBUTE,
  OUTPUT_TOKENS_ATTRIBUTE,
  COST_ATTRIBUTE,
]);

/** Counter bumped for each dishonored task claim (see contract above). */
export const TASK_ID_REJECTED_COUNTER = "telemetry.task_id_rejected";

const INT64_MAX = (1n << 63n) - 1n;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Exact integer binding: Number while safe, BigInt past 2^53. */
export type IntBinding = number | bigint;

export interface SpanUsage {
  /** True when the span carries at least one mapped gen_ai.* attribute. */
  hasUsage: boolean;
  model: string | null;
  provider: string | null;
  inputTokens: IntBinding | null;
  outputTokens: IntBinding | null;
  reportedCostMicroUsd: IntBinding | null;
  costSource: "reported" | "unknown";
  /** Extra gen_ai.usage.* integer attributes; null when none. */
  otherTokenCategories: Record<string, number> | null;
}

function findAttribute(
  attrs: OtelAttribute[],
  key: string,
): OtelAttributeValue | undefined {
  for (const attr of attrs) {
    if (attr.key === key) return attr.value;
  }
  return undefined;
}

function stringValue(value: OtelAttributeValue | undefined): string | null {
  if (value !== undefined && "stringValue" in value) return value.stringValue;
  return null;
}

/**
 * Parse an OTLP int (protojson decimal string, exact past 2^53).
 * Anything else — bool/double shapes, garbage, negatives (tokens and
 * costs cannot be negative), out-of-int64-range — is NULL, never an
 * error.
 */
function intValue(value: OtelAttributeValue | undefined): IntBinding | null {
  if (value === undefined || !("intValue" in value)) return null;
  if (!/^-?\d+$/.test(value.intValue)) return null;
  let parsed: bigint;
  try {
    parsed = BigInt(value.intValue);
  } catch {
    return null;
  }
  if (parsed < 0n || parsed > INT64_MAX) return null;
  return parsed <= MAX_SAFE ? Number(parsed) : parsed;
}

export function deriveSpanUsage(span: ValidatedSpan): SpanUsage {
  let hasUsage = false;
  for (const attr of span.attributes) {
    if (MAPPED_USAGE_KEYS.has(attr.key)) {
      hasUsage = true;
      break;
    }
  }
  const cost = intValue(findAttribute(span.attributes, COST_ATTRIBUTE));
  const other: Record<string, number> = {};
  if (hasUsage) {
    for (const attr of span.attributes) {
      if (
        !attr.key.startsWith(USAGE_PREFIX) ||
        MAPPED_USAGE_KEYS.has(attr.key)
      ) {
        continue;
      }
      const parsed = intValue(attr.value);
      if (typeof parsed === "number") other[attr.key] = parsed;
    }
  }
  return {
    hasUsage,
    model: stringValue(findAttribute(span.attributes, MODEL_ATTRIBUTE)),
    provider: stringValue(findAttribute(span.attributes, PROVIDER_ATTRIBUTE)),
    inputTokens: intValue(
      findAttribute(span.attributes, INPUT_TOKENS_ATTRIBUTE),
    ),
    outputTokens: intValue(
      findAttribute(span.attributes, OUTPUT_TOKENS_ATTRIBUTE),
    ),
    reportedCostMicroUsd: cost,
    costSource: cost === null ? "unknown" : "reported",
    otherTokenCategories: Object.keys(other).length > 0 ? other : null,
  };
}

/**
 * Honor a span's `polymer.task_id` claim only when the ingesting agent
 * coordinates or is assigned to that task. Returns the task to store
 * (null when no claim or a dishonored one) and whether the rejection
 * counter must increment.
 */
export function resolveUsageTask(
  db: PolymerDatabase,
  agentId: string,
  span: ValidatedSpan,
): { taskId: string | null; rejected: boolean } {
  const claimed = stringValue(
    findAttribute(span.attributes, TASK_ID_ATTRIBUTE),
  );
  if (claimed === null || claimed === "")
    return { taskId: null, rejected: false };
  const row = db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM tasks
                      WHERE task_id = ? AND coordinator = ?)
          OR EXISTS(SELECT 1 FROM task_assignments
                      WHERE task_id = ? AND agent_id = ?) AS ok`,
    )
    .get(claimed, agentId, claimed, agentId) as { ok: number } | undefined;
  if (row?.ok === 1) return { taskId: claimed, rejected: false };
  return { taskId: null, rejected: true };
}

export interface UsageRecord {
  usage_id: string;
  agent_id: string;
  task_id: string | null;
  trace_id: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: IntBinding | null;
  output_tokens: IntBinding | null;
  other_token_categories: Record<string, number> | null;
  reported_cost_micro_usd: IntBinding | null;
  cost_source: "reported" | "unknown";
  recorded_at: string;
}

/** Win-condition read: how many tokens did this agent consume? */
export function tokensConsumedByAgent(
  db: PolymerDatabase,
  agentId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0) AS total
         FROM usage_records WHERE agent_id = ?`,
    )
    .get(agentId) as { total: number } | undefined;
  return row?.total ?? 0;
}

/** Win-condition read: how much reported cost belongs to this task? */
export function reportedCostForTask(
  db: PolymerDatabase,
  taskId: string,
): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(reported_cost_micro_usd), 0) AS total
         FROM usage_records WHERE task_id = ?`,
    )
    .get(taskId) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function getTelemetryCounter(db: PolymerDatabase, name: string): number {
  const row = db
    .prepare("SELECT value FROM telemetry_counters WHERE name = ?")
    .get(name) as { value: number } | undefined;
  return row?.value ?? 0;
}
