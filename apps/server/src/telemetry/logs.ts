import { createHash, randomUUID } from "node:crypto";
import {
  malformed,
  OtelError,
  Reader,
  type OtelAttributeValue,
} from "./otlp.js";
import { intValue, type IntBinding } from "./usage.js";

/**
 * OTLP logs intake (#159): Claude Code's `api_request` events become
 * usage rows. A WHITELIST decoder: only the fixed fields below are ever
 * extracted from a record, and only `api_request` records yield an
 * event. Every other record, attribute, body and resource attribute
 * (prompts, responses, tool details, user ids...) is skipped without
 * being queued, logged or stored. The body is necessarily held
 * transiently by JSON.parse / the protobuf reader; nothing from it
 * outlives the call except the whitelisted fields.
 *
 * Bounds: kept `api_request` events are capped at `maxEvents`
 * (`telemetry.batch_max_spans`); scanned records are bounded separately
 * by the request byte cap plus MAX_LOG_RECORDS_SCANNED, so a busy
 * session's noise events can never turn real usage into a 413.
 * Error paths throw OtelError codes only, never record text.
 */

/** Fixed ceiling on records walked per request (kept events are capped separately). */
export const MAX_LOG_RECORDS_SCANNED = 100_000;

/** The only attribute keys read from a log record. */
const KEY_EVENT_NAME = "event.name";
const KEY_MODEL = "model";
const KEY_INPUT = "input_tokens";
const KEY_OUTPUT = "output_tokens";
const KEY_CACHE_READ = "cache_read_tokens";
const KEY_CACHE_CREATE = "cache_creation_tokens";
const KEY_COST_MICROS = "cost_usd_micros";
const KEY_SESSION = "session.id";
const KEY_SEQUENCE = "event.sequence";
const KEY_TIMESTAMP = "event.timestamp";
const KEY_TASK = "polymer.task_id";

const WANTED = new Set([
  KEY_EVENT_NAME,
  KEY_MODEL,
  KEY_INPUT,
  KEY_OUTPUT,
  KEY_CACHE_READ,
  KEY_CACHE_CREATE,
  KEY_COST_MICROS,
  KEY_SESSION,
  KEY_SEQUENCE,
  KEY_TIMESTAMP,
  KEY_TASK,
]);

/** Only this key is read from Resource.attributes. */
const RESOURCE_WANTED = new Set([KEY_TASK]);

/** A task claim is a UUID-shaped string of at most this many chars. */
const MAX_CLAIM_CHARS = 36;
const CLAIM_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest string kept from any whitelisted attribute. */
const MAX_FIELD_CHARS = 256;

export interface UsageEvent {
  model: string | null;
  inputTokens: IntBinding | null;
  outputTokens: IntBinding | null;
  cacheReadTokens: IntBinding | null;
  cacheCreationTokens: IntBinding | null;
  /** From the integer `cost_usd_micros` only; the double `cost_usd` is never read. */
  costMicroUsd: IntBinding | null;
  sessionId: string | null;
  sequence: IntBinding | null;
  timestamp: string | null;
  /**
   * `polymer.task_id` (record attribute, else resource attribute) when
   * it is a UUID-shaped string; honored only through resolveUsageTask.
   */
  taskClaim: string | null;
  /** A string claim was present but over-long or not UUID-shaped: rejected, never echoed. */
  taskClaimMalformed: boolean;
}

export interface ParsedLogs {
  events: UsageEvent[];
}

type Bag = Map<string, OtelAttributeValue>;

function isApiRequest(bag: Bag): boolean {
  const v = bag.get(KEY_EVENT_NAME);
  return (
    v !== undefined &&
    "stringValue" in v &&
    (v.stringValue === "api_request" ||
      v.stringValue === "claude_code.api_request")
  );
}

function str(v: OtelAttributeValue | undefined): string | null {
  return v !== undefined &&
    "stringValue" in v &&
    v.stringValue.length <= MAX_FIELD_CHARS
    ? v.stringValue
    : null;
}

/**
 * Task claim from the record, else from the resource. Absent, empty or
 * non-string values mean "no claim" (ignored); a non-empty string that
 * is over-long or not UUID-shaped is a malformed claim (counted as
 * rejected by the writer, never stored or logged).
 */
function claimOf(
  record: OtelAttributeValue | undefined,
  resource: OtelAttributeValue | undefined,
): { claim: string | null; malformed: boolean } {
  const v = record !== undefined && "stringValue" in record ? record : resource;
  if (v === undefined || !("stringValue" in v) || v.stringValue === "") {
    return { claim: null, malformed: false };
  }
  if (
    v.stringValue.length > MAX_CLAIM_CHARS ||
    !CLAIM_SHAPE.test(v.stringValue)
  ) {
    return { claim: null, malformed: true };
  }
  return { claim: v.stringValue, malformed: false };
}

function toEvent(bag: Bag, resource: Bag): UsageEvent {
  const claim = claimOf(bag.get(KEY_TASK), resource.get(KEY_TASK));
  return {
    model: str(bag.get(KEY_MODEL)),
    inputTokens: intValue(bag.get(KEY_INPUT)),
    outputTokens: intValue(bag.get(KEY_OUTPUT)),
    cacheReadTokens: intValue(bag.get(KEY_CACHE_READ)),
    cacheCreationTokens: intValue(bag.get(KEY_CACHE_CREATE)),
    costMicroUsd: intValue(bag.get(KEY_COST_MICROS)),
    sessionId: str(bag.get(KEY_SESSION)),
    sequence: intValue(bag.get(KEY_SEQUENCE)),
    timestamp: str(bag.get(KEY_TIMESTAMP)),
    taskClaim: claim.claim,
    taskClaimMalformed: claim.malformed,
  };
}

/** Scalar AnyValue (string/int/double) from protobuf bytes; null for anything else. */
function decodeScalar(buf: Uint8Array): OtelAttributeValue | null {
  const r = new Reader(buf);
  while (!r.eof()) {
    const [field, wire] = r.tag();
    if (field === 1 && wire === 2) {
      return { stringValue: Buffer.from(r.bytes()).toString("utf8") };
    }
    if (field === 3 && wire === 0) return { intValue: r.int64().toString() };
    if (field === 4 && wire === 1) return { doubleValue: r.fixedDouble() };
    r.skip(wire);
  }
  return null;
}

/** KeyValue: the key is read first; the value only if the key is whitelisted. */
function decodeWantedKeyValue(
  buf: Uint8Array,
  bag: Bag,
  wanted: Set<string> = WANTED,
): void {
  const r = new Reader(buf);
  let key: string | null = null;
  let valueBytes: Uint8Array | null = null;
  while (!r.eof()) {
    const [field, wire] = r.tag();
    if (field === 1 && wire === 2) {
      const raw = r.bytes();
      // Whitelist keys are short; anything longer cannot match.
      key = raw.length <= 64 ? Buffer.from(raw).toString("utf8") : "";
    } else if (field === 2 && wire === 2) {
      valueBytes = r.bytes();
    } else {
      r.skip(wire);
    }
  }
  if (key === null || valueBytes === null || !wanted.has(key)) return;
  const value = decodeScalar(valueBytes);
  if (value !== null) bag.set(key, value);
}

function decodeLogRecordProto(buf: Uint8Array): Bag {
  const bag: Bag = new Map();
  const r = new Reader(buf);
  while (!r.eof()) {
    const [field, wire] = r.tag();
    if (field === 6 && wire === 2) decodeWantedKeyValue(r.bytes(), bag);
    else r.skip(wire);
  }
  return bag;
}

function decodeProtobufLogs(buf: Uint8Array, maxEvents: number): UsageEvent[] {
  const events: UsageEvent[] = [];
  let scanned = 0;
  const top = new Reader(buf);
  while (!top.eof()) {
    const [f1, w1] = top.tag();
    if (!(f1 === 1 && w1 === 2)) {
      top.skip(w1);
      continue;
    }
    // ResourceLogs: resource (1) and scope_logs (2) may arrive in any
    // order, so collect first, then decode scopes against the resource.
    const rl = new Reader(top.bytes());
    const resource: Bag = new Map();
    const scopes: Uint8Array[] = [];
    while (!rl.eof()) {
      const [f2, w2] = rl.tag();
      if (f2 === 1 && w2 === 2) {
        // Resource.attributes is field 1 (not 2; see #154 for traces).
        const res = new Reader(rl.bytes());
        while (!res.eof()) {
          const [f, w] = res.tag();
          if (f === 1 && w === 2) {
            decodeWantedKeyValue(res.bytes(), resource, RESOURCE_WANTED);
          } else {
            res.skip(w);
          }
        }
      } else if (f2 === 2 && w2 === 2) {
        scopes.push(rl.bytes());
      } else {
        rl.skip(w2);
      }
    }
    for (const scope of scopes) {
      const sl = new Reader(scope); // ScopeLogs
      while (!sl.eof()) {
        const [f3, w3] = sl.tag();
        if (!(f3 === 2 && w3 === 2)) {
          sl.skip(w3);
          continue;
        }
        if (++scanned > MAX_LOG_RECORDS_SCANNED) {
          throw new OtelError("payload_too_large");
        }
        const bag = decodeLogRecordProto(sl.bytes());
        if (!isApiRequest(bag)) continue;
        if (events.length >= maxEvents) {
          throw new OtelError("payload_too_large");
        }
        events.push(toEvent(bag, resource));
      }
    }
  }
  return events;
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw malformed();
  }
  return v as Record<string, unknown>;
}

function arr(v: unknown): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw malformed();
  return v;
}

function jsonScalar(v: unknown): OtelAttributeValue | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r["stringValue"] === "string") {
    return { stringValue: r["stringValue"] };
  }
  const i = r["intValue"];
  if (
    (typeof i === "string" && /^-?\d+$/.test(i)) ||
    (typeof i === "number" && Number.isInteger(i))
  ) {
    return { intValue: String(i) };
  }
  if (typeof r["doubleValue"] === "number") {
    return { doubleValue: r["doubleValue"] };
  }
  return null;
}

function decodeJsonLogs(root: unknown, maxEvents: number): UsageEvent[] {
  const events: UsageEvent[] = [];
  let scanned = 0;
  for (const rl of arr(obj(root)["resourceLogs"])) {
    const resource: Bag = new Map();
    const resObj = obj(rl)["resource"];
    if (resObj !== undefined) {
      for (const kv of arr(obj(resObj)["attributes"])) {
        const e = obj(kv);
        if (e["key"] !== KEY_TASK) continue;
        const value = jsonScalar(e["value"]);
        if (value !== null) resource.set(KEY_TASK, value);
      }
    }
    for (const sl of arr(obj(rl)["scopeLogs"])) {
      for (const rec of arr(obj(sl)["logRecords"])) {
        if (++scanned > MAX_LOG_RECORDS_SCANNED) {
          throw new OtelError("payload_too_large");
        }
        const bag: Bag = new Map();
        for (const kv of arr(obj(rec)["attributes"])) {
          const e = obj(kv);
          const key = e["key"];
          if (typeof key !== "string" || !WANTED.has(key)) continue;
          const value = jsonScalar(e["value"]);
          if (value !== null) bag.set(key, value);
        }
        if (!isApiRequest(bag)) continue;
        if (events.length >= maxEvents) {
          throw new OtelError("payload_too_large");
        }
        events.push(toEvent(bag, resource));
      }
    }
  }
  return events;
}

/**
 * Parse one OTLP logs batch into usage events. Throws OtelError only
 * (`invalid_request`, `payload_too_large`); never carries record text.
 */
export function parseOtlpLogs(
  contentType: string | undefined,
  body: Uint8Array,
  maxEvents: number,
): ParsedLogs {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  try {
    if (media === "application/x-protobuf") {
      return { events: decodeProtobufLogs(body, maxEvents) };
    }
    if (media === "application/json") {
      return {
        events: decodeJsonLogs(
          JSON.parse(Buffer.from(body).toString("utf8")),
          maxEvents,
        ),
      };
    }
  } catch (err) {
    if (err instanceof OtelError) throw err;
    throw malformed(); // JSON.parse messages can quote input; drop them
  }
  throw malformed();
}

/**
 * Row id for an event. Deterministic only when session.id, event.sequence
 * and event.timestamp are ALL present (hash also covers agent, model,
 * tokens and cost, so a key collision with different content is a
 * different row, never silently ignored). Otherwise a random id:
 * idempotency does not apply and nothing is collapsed.
 */
export function usageEventId(agentId: string, e: UsageEvent): string {
  if (e.sessionId === null || e.sequence === null || e.timestamp === null) {
    return randomUUID();
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        agentId,
        e.sessionId,
        String(e.sequence),
        e.timestamp,
        e.model,
        ...[
          e.inputTokens,
          e.outputTokens,
          e.cacheReadTokens,
          e.cacheCreationTokens,
          e.costMicroUsd,
        ].map((n) => (n === null ? null : String(n))),
      ]),
    )
    .digest("hex");
}
