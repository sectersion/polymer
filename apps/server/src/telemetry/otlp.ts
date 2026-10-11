/**
 * Component 22: OTLP trace batch parsing and validation.
 *
 * Two wire forms per the ingestion contract: `application/x-protobuf`
 * (preferred, decoded with the minimal reader below — the OTel JS
 * SDK ships no public protobuf decoder, so the few fields we need
 * are walked by hand) and `application/json` (protojson, camelCase).
 *
 * Validation is structural only: well-formed envelope, valid span
 * ids, span count. Agent identity never comes from the payload — the
 * HTTP layer authenticates the Bearer credential and that principal
 * is authoritative for everything downstream (quotas, storage).
 */

export interface ValidatedSpan {
  traceId: string;
  spanId: string;
  /** Null when the span is a root. */
  parentSpanId: string | null;
  name: string;
  /** OTLP SpanKind number (0-5). */
  kind: number;
  /** Unix nanos, decimal strings (exact past 2^53). */
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  /** OTLP StatusCode number (0 unset, 1 ok, 2 error). */
  statusCode: number;
  statusMessage: string | null;
  attributes: OtelAttribute[];
  resourceAttributes: OtelAttribute[];
  scope: { name: string; version: string };
}

/** Native OTLP attribute value shape (protojson-compatible). */
export type OtelAttributeValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtelAttributeValue[] } }
  | {
      kvlistValue: {
        values: Array<{ key: string; value: OtelAttributeValue }>;
      };
    }
  | { bytesValue: string };

export interface OtelAttribute {
  key: string;
  value: OtelAttributeValue;
}

export class OtelError extends Error {
  constructor(readonly code: "invalid_request" | "payload_too_large") {
    super(code);
    this.name = "OtelError";
  }
}

const malformed = (): OtelError => new OtelError("invalid_request");

/** Minimal protobuf reader: only the wire types OTLP trace uses. */
class Reader {
  pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  eof(): boolean {
    return this.pos >= this.buf.length;
  }

  /** 32-bit varint (tags and lengths always fit). */
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.pos >= this.buf.length) throw malformed();
      if (shift >= 35) throw malformed();
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
  }

  tag(): [field: number, wire: number] {
    const v = this.varint();
    return [v >>> 3, v & 7];
  }

  /** Full 64-bit varint as BigInt (int64 fields exceed 2^53). */
  varint64(): bigint {
    let result = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (this.pos >= this.buf.length) throw malformed();
      if (shift >= 70n) throw malformed();
      const b = BigInt(this.buf[this.pos++]);
      result |= (b & 0x7fn) << shift;
      if ((b & 0x80n) === 0n) return result;
    }
  }

  /**
   * Signed int64 (OTLP `int64` is two's-complement): values at or past
   * 2^63 wrap negative. Without this, a span carrying -5 decodes as
   * 18446744073709551611 and the stored attributes lie.
   */
  int64(): bigint {
    const unsigned = this.varint64();
    return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
  }

  /** Little-endian fixed64 as BigInt (timestamps, doubles' bits). */
  fixed64(): bigint {
    if (8 > this.buf.length - this.pos) throw malformed();
    let result = 0n;
    for (let i = 0; i < 8; i += 1) {
      result |= BigInt(this.buf[this.pos++]) << BigInt(8 * i);
    }
    return result;
  }

  fixedDouble(): number {
    if (8 > this.buf.length - this.pos) throw malformed();
    const view = new DataView(
      this.buf.buffer,
      this.buf.byteOffset + this.pos,
      8,
    );
    this.pos += 8;
    return view.getFloat64(0, true);
  }

  bytes(): Uint8Array {
    const len = this.varint();
    if (len > this.buf.length - this.pos) throw malformed();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }

  skip(wire: number): void {
    if (wire === 0) {
      this.varint();
    } else if (wire === 1) {
      this.skipN(8);
    } else if (wire === 2) {
      this.skipN(this.varint());
    } else if (wire === 5) {
      this.skipN(4);
    } else {
      throw malformed();
    }
  }

  private skipN(n: number): void {
    if (n > this.buf.length - this.pos) throw malformed();
    this.pos += n;
  }
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/** 16-byte trace ids / 8-byte span ids, hex, non-zero. */
function checkId(hex: string, chars: number): boolean {
  return hex.length === chars && /^[0-9a-f]+$/.test(hex) && !/^0+$/.test(hex);
}

function checkSpan(traceId: string, spanId: string): void {
  if (!checkId(traceId, 32) || !checkId(spanId, 16)) throw malformed();
}

function checkParentSpanId(hex: string): void {
  if (!checkId(hex, 16)) throw malformed();
}

function decodeAttributeValue(reader: Reader): OtelAttributeValue {
  for (;;) {
    if (reader.eof()) throw malformed();
    const [field, wire] = reader.tag();
    if (field === 1 && wire === 2) {
      const raw = reader.bytes();
      return { stringValue: Buffer.from(raw).toString("utf8") };
    }
    if (field === 2 && wire === 0) {
      return { boolValue: reader.varint() !== 0 };
    }
    if (field === 3 && wire === 0) {
      // int64: exact as decimal string (protojson-compatible).
      return { intValue: reader.int64().toString() };
    }
    if (field === 4 && wire === 1) {
      return { doubleValue: reader.fixedDouble() };
    }
    if (field === 5 && wire === 2) {
      const inner = new Reader(reader.bytes());
      const values: OtelAttributeValue[] = [];
      for (;;) {
        if (inner.eof()) break;
        const [f, w] = inner.tag();
        if (f === 1 && w === 2) {
          values.push(decodeAttributeValue(new Reader(inner.bytes())));
        } else {
          inner.skip(w);
        }
      }
      return { arrayValue: { values } };
    }
    if (field === 6 && wire === 2) {
      const inner = new Reader(reader.bytes());
      const values: Array<{ key: string; value: OtelAttributeValue }> = [];
      for (;;) {
        if (inner.eof()) break;
        const [f, w] = inner.tag();
        if (f === 1 && w === 2) {
          values.push(decodeKeyValue(new Reader(inner.bytes())));
        } else {
          inner.skip(w);
        }
      }
      return { kvlistValue: { values } };
    }
    if (field === 7 && wire === 2) {
      return { bytesValue: Buffer.from(reader.bytes()).toString("base64") };
    }
    reader.skip(wire);
  }
}

function decodeKeyValue(reader: Reader): {
  key: string;
  value: OtelAttributeValue;
} {
  let key: string | undefined;
  let value: OtelAttributeValue | undefined;
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (field === 1 && wire === 2) {
      key = Buffer.from(reader.bytes()).toString("utf8");
    } else if (field === 2 && wire === 2) {
      value = decodeAttributeValue(new Reader(reader.bytes()));
    } else {
      reader.skip(wire);
    }
  }
  if (key === undefined || value === undefined) throw malformed();
  return { key, value };
}

function decodeResourceAttributes(reader: Reader): OtelAttribute[] {
  // Resource.attributes is field 2, repeated KeyValue: one entry per
  // field occurrence (no wrapper message).
  const out: OtelAttribute[] = [];
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (field === 2 && wire === 2) {
      out.push(decodeKeyValue(new Reader(reader.bytes())));
    } else {
      reader.skip(wire);
    }
  }
  return out;
}

function decodeStatus(reader: Reader): {
  code: number;
  message: string | null;
} {
  let code = 0;
  let message: string | null = null;
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (field === 2 && wire === 0) {
      code = reader.varint();
    } else if (field === 3 && wire === 2) {
      message = Buffer.from(reader.bytes()).toString("utf8");
    } else {
      reader.skip(wire);
    }
  }
  return { code, message };
}

interface DecodedScope {
  name: string;
  version: string;
}

function decodeScope(reader: Reader): DecodedScope {
  let name = "";
  let version = "";
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (field === 1 && wire === 2) {
      name = Buffer.from(reader.bytes()).toString("utf8");
    } else if (field === 2 && wire === 2) {
      version = Buffer.from(reader.bytes()).toString("utf8");
    } else {
      reader.skip(wire);
    }
  }
  return { name, version };
}

function decodeSpan(
  reader: Reader,
  spans: ValidatedSpan[],
  resourceAttributes: OtelAttribute[],
  scope: DecodedScope,
): void {
  let traceId = "";
  let spanId = "";
  let parentSpanId: string | null = null;
  let name = "";
  let kind = 0;
  let startTimeUnixNano = "0";
  let endTimeUnixNano = "0";
  let statusCode = 0;
  let statusMessage: string | null = null;
  const attributes: OtelAttribute[] = [];
  let hasTraceId = false;
  let hasSpanId = false;
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (field === 1 && wire === 2) {
      const raw = reader.bytes();
      if (raw.length !== 16) throw malformed();
      traceId = toHex(raw);
      hasTraceId = true;
    } else if (field === 2 && wire === 2) {
      const raw = reader.bytes();
      if (raw.length !== 8) throw malformed();
      spanId = toHex(raw);
      hasSpanId = true;
    } else if (field === 4 && wire === 2) {
      const raw = reader.bytes();
      if (raw.length !== 8) throw malformed();
      parentSpanId = toHex(raw);
      checkParentSpanId(parentSpanId);
    } else if (field === 5 && wire === 2) {
      name = Buffer.from(reader.bytes()).toString("utf8");
    } else if (field === 6 && wire === 0) {
      kind = reader.varint();
    } else if (field === 7 && wire === 1) {
      startTimeUnixNano = reader.fixed64().toString();
    } else if (field === 8 && wire === 1) {
      endTimeUnixNano = reader.fixed64().toString();
    } else if (field === 9 && wire === 2) {
      // Span.attributes is field 9, repeated KeyValue: one entry per
      // field occurrence (no wrapper message).
      attributes.push(decodeKeyValue(new Reader(reader.bytes())));
    } else if (field === 15 && wire === 2) {
      const status = decodeStatus(new Reader(reader.bytes()));
      statusCode = status.code;
      statusMessage = status.message;
    } else if ((field === 1 || field === 2 || field === 5) && wire !== 2) {
      throw malformed();
    } else {
      reader.skip(wire);
    }
  }
  if (!hasTraceId || !hasSpanId) throw malformed();
  checkSpan(traceId, spanId);
  spans.push({
    traceId,
    spanId,
    parentSpanId,
    name,
    kind,
    startTimeUnixNano,
    endTimeUnixNano,
    statusCode,
    statusMessage,
    attributes,
    resourceAttributes,
    scope: { ...scope },
  });
}

function decodeScopeSpans(
  reader: Reader,
  spans: ValidatedSpan[],
  resourceAttributes: OtelAttribute[],
): void {
  // Scope (field 1) and spans (field 2, repeated) are siblings of
  // one ScopeSpans message, in any order: collect first, then decode
  // every span against the block's scope. Spans inherit a copy each.
  let scope: DecodedScope = { name: "", version: "" };
  const spanPayloads: Uint8Array[] = [];
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (wire !== 2) {
      reader.skip(wire);
      continue;
    }
    if (field === 1) {
      scope = decodeScope(new Reader(reader.bytes()));
    } else if (field === 2) {
      spanPayloads.push(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  for (const payload of spanPayloads) {
    decodeSpan(new Reader(payload), spans, resourceAttributes, scope);
  }
}

function decodeResourceSpans(reader: Reader, spans: ValidatedSpan[]): void {
  // Resource (field 1) and ScopeSpans (field 2) are siblings: the
  // resource attributes must apply to every span below, so collect
  // payloads first, decode the resource, then the scopes — order in
  // the message does not matter.
  const resourcePayloads: Uint8Array[] = [];
  const scopePayloads: Uint8Array[] = [];
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (wire !== 2) {
      reader.skip(wire);
      continue;
    }
    if (field === 1) {
      resourcePayloads.push(reader.bytes());
    } else if (field === 2) {
      scopePayloads.push(reader.bytes());
    } else {
      reader.skip(wire);
    }
  }
  const resourceAttributes: OtelAttribute[] = [];
  for (const payload of resourcePayloads) {
    resourceAttributes.push(...decodeResourceAttributes(new Reader(payload)));
  }
  for (const payload of scopePayloads) {
    decodeScopeSpans(new Reader(payload), spans, resourceAttributes);
  }
}

function decodeProtobuf(buf: Uint8Array): ValidatedSpan[] {
  const reader = new Reader(buf);
  const spans: ValidatedSpan[] = [];
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    // Field 1 (resource_spans) is length-delimited.
    if (field === 1 && wire === 2) {
      decodeResourceSpans(new Reader(reader.bytes()), spans);
    } else {
      reader.skip(wire);
    }
  }
  return spans;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  return value as Record<string, unknown>;
}

const SPAN_KINDS: Record<string, number> = {
  SPAN_KIND_UNSPECIFIED: 0,
  SPAN_KIND_INTERNAL: 1,
  SPAN_KIND_SERVER: 2,
  SPAN_KIND_CLIENT: 3,
  SPAN_KIND_PRODUCER: 4,
  SPAN_KIND_CONSUMER: 5,
};

const STATUS_CODES: Record<string, number> = {
  STATUS_CODE_UNSET: 0,
  STATUS_CODE_OK: 1,
  STATUS_CODE_ERROR: 2,
};

function decodeJsonEnum(
  value: unknown,
  names: Record<string, number>,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && names[value] !== undefined) {
    return names[value];
  }
  throw malformed();
}

function decodeJsonNano(value: unknown): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text)) throw malformed();
  return text.replace(/^0+(?=\d)/, "");
}

function decodeJsonAttributeValue(value: unknown): OtelAttributeValue {
  const record = asRecord(value);
  if (typeof record["stringValue"] === "string") {
    return { stringValue: record["stringValue"] };
  }
  if (typeof record["boolValue"] === "boolean") {
    return { boolValue: record["boolValue"] };
  }
  if (
    typeof record["intValue"] === "string" ||
    typeof record["intValue"] === "number"
  ) {
    const text = String(record["intValue"]);
    if (!/^-?\d+$/.test(text)) throw malformed();
    return { intValue: text };
  }
  if (typeof record["doubleValue"] === "number") {
    return { doubleValue: record["doubleValue"] };
  }
  if (typeof record["bytesValue"] === "string") {
    return { bytesValue: record["bytesValue"] };
  }
  if (record["arrayValue"] !== undefined) {
    const items = asRecord(record["arrayValue"])["values"] ?? [];
    if (!Array.isArray(items)) throw malformed();
    return { arrayValue: { values: items.map(decodeJsonAttributeValue) } };
  }
  if (record["kvlistValue"] !== undefined) {
    const items = asRecord(record["kvlistValue"])["values"] ?? [];
    if (!Array.isArray(items)) throw malformed();
    return {
      kvlistValue: {
        values: items.map((item) => {
          const entry = asRecord(item);
          if (typeof entry["key"] !== "string") throw malformed();
          return {
            key: entry["key"] as string,
            value: decodeJsonAttributeValue(entry["value"]),
          };
        }),
      },
    };
  }
  throw malformed();
}

function decodeJsonAttributes(value: unknown): OtelAttribute[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw malformed();
  return value.map((item) => {
    const entry = asRecord(item);
    if (typeof entry["key"] !== "string") throw malformed();
    return {
      key: entry["key"] as string,
      value: decodeJsonAttributeValue(entry["value"]),
    };
  });
}

function decodeJsonScope(value: unknown): { name: string; version: string } {
  if (value === undefined) return { name: "", version: "" };
  const scope = asRecord(value);
  return {
    name: typeof scope["name"] === "string" ? scope["name"] : "",
    version: typeof scope["version"] === "string" ? scope["version"] : "",
  };
}

function decodeJson(value: unknown): ValidatedSpan[] {
  const root = asRecord(value);
  const resourceSpans = root["resourceSpans"] ?? [];
  if (!Array.isArray(resourceSpans)) throw malformed();
  const spans: ValidatedSpan[] = [];
  for (const rs of resourceSpans) {
    const resource = asRecord(rs);
    const resourceAttributes = decodeJsonAttributes(
      resource["resource"] !== undefined
        ? asRecord(resource["resource"])["attributes"]
        : undefined,
    );
    const scopeSpans = resource["scopeSpans"] ?? [];
    if (!Array.isArray(scopeSpans)) throw malformed();
    for (const ss of scopeSpans) {
      const scopeBlock = asRecord(ss);
      const scope = decodeJsonScope(scopeBlock["scope"]);
      const list = scopeBlock["spans"] ?? [];
      if (!Array.isArray(list)) throw malformed();
      for (const item of list) {
        const span = asRecord(item);
        const traceId = span["traceId"];
        const spanId = span["spanId"];
        if (typeof traceId !== "string" || typeof spanId !== "string") {
          throw malformed();
        }
        checkSpan(traceId.toLowerCase(), spanId.toLowerCase());
        const parent = span["parentSpanId"];
        let parentSpanId: string | null = null;
        if (parent !== undefined && parent !== "") {
          if (typeof parent !== "string") throw malformed();
          checkParentSpanId(parent.toLowerCase());
          parentSpanId = parent.toLowerCase();
        }
        const status =
          span["status"] === undefined
            ? { code: 0, message: null as string | null }
            : {
                code: decodeJsonEnum(
                  asRecord(span["status"])["code"],
                  STATUS_CODES,
                  0,
                ),
                message: (() => {
                  const message = asRecord(span["status"])["message"];
                  return typeof message === "string" ? message : null;
                })(),
              };
        const name = span["name"];
        spans.push({
          traceId: traceId.toLowerCase(),
          spanId: spanId.toLowerCase(),
          parentSpanId,
          name: typeof name === "string" ? name : "",
          kind: decodeJsonEnum(span["kind"], SPAN_KINDS, 0),
          startTimeUnixNano:
            span["startTimeUnixNano"] === undefined
              ? "0"
              : decodeJsonNano(span["startTimeUnixNano"]),
          endTimeUnixNano:
            span["endTimeUnixNano"] === undefined
              ? "0"
              : decodeJsonNano(span["endTimeUnixNano"]),
          statusCode: status.code,
          statusMessage: status.message,
          attributes: decodeJsonAttributes(span["attributes"]),
          resourceAttributes,
          scope: { ...scope },
        });
      }
    }
  }
  return spans;
}

export interface ParsedBatch {
  spans: ValidatedSpan[];
}

/**
 * Parse and structurally validate one OTLP trace batch. Throws
 * OtelError("invalid_request") on malformed payloads and
 * OtelError("payload_too_large") past `maxSpans`.
 */
export function parseOtlpBatch(
  contentType: string | undefined,
  body: Uint8Array,
  maxSpans: number,
): ParsedBatch {
  const media = (contentType ?? "").split(";")[0].trim().toLowerCase();
  let raw: ValidatedSpan[];
  if (media === "application/x-protobuf") {
    raw = decodeProtobuf(body);
  } else if (media === "application/json") {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      throw malformed();
    }
    raw = decodeJson(value);
  } else {
    throw malformed();
  }
  if (raw.length > maxSpans) {
    throw new OtelError("payload_too_large");
  }
  return { spans: raw };
}
