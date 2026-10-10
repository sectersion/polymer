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
  name: string;
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

interface RawSpan {
  traceId: string;
  spanId: string;
  name: string;
}

function checkSpan(traceId: string, spanId: string): void {
  if (!checkId(traceId, 32) || !checkId(spanId, 16)) throw malformed();
}

function decodeSpan(reader: Reader, spans: RawSpan[]): void {
  let traceId = "";
  let spanId = "";
  let name = "";
  let hasTraceId = false;
  let hasSpanId = false;
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (wire !== 2) {
      // trace_id/span_id/name are length-delimited; anything else on
      // a span is skipped by wire type below.
      if (field === 1 || field === 2 || field === 5) throw malformed();
      reader.skip(wire);
      continue;
    }
    if (field === 1) {
      const raw = reader.bytes();
      if (raw.length !== 16) throw malformed();
      traceId = toHex(raw);
      hasTraceId = true;
    } else if (field === 2) {
      const raw = reader.bytes();
      if (raw.length !== 8) throw malformed();
      spanId = toHex(raw);
      hasSpanId = true;
    } else if (field === 5) {
      const raw = reader.bytes();
      name = Buffer.from(raw).toString("utf8");
    } else {
      reader.skip(wire);
    }
  }
  if (!hasTraceId || !hasSpanId) throw malformed();
  checkSpan(traceId, spanId);
  spans.push({ traceId, spanId, name });
}

function decodeScopeSpans(reader: Reader, spans: RawSpan[]): void {
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    // Field 2 (spans) is length-delimited; anything else skips.
    if (field === 2 && wire === 2) {
      decodeSpan(new Reader(reader.bytes()), spans);
    } else {
      reader.skip(wire);
    }
  }
}

function decodeResourceSpans(reader: Reader, spans: RawSpan[]): void {
  for (;;) {
    if (reader.eof()) break;
    const [field, wire] = reader.tag();
    if (field === 2 && wire === 2) {
      decodeScopeSpans(new Reader(reader.bytes()), spans);
    } else {
      reader.skip(wire);
    }
  }
}

function decodeProtobuf(buf: Uint8Array): RawSpan[] {
  const reader = new Reader(buf);
  const spans: RawSpan[] = [];
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

function decodeJson(value: unknown): RawSpan[] {
  const root = asRecord(value);
  const resourceSpans = root["resourceSpans"] ?? [];
  if (!Array.isArray(resourceSpans)) throw malformed();
  const spans: RawSpan[] = [];
  for (const rs of resourceSpans) {
    const scopeSpans = asRecord(rs)["scopeSpans"] ?? [];
    if (!Array.isArray(scopeSpans)) throw malformed();
    for (const ss of scopeSpans) {
      const list = asRecord(ss)["spans"] ?? [];
      if (!Array.isArray(list)) throw malformed();
      for (const item of list) {
        const span = asRecord(item);
        const traceId = span["traceId"];
        const spanId = span["spanId"];
        if (typeof traceId !== "string" || typeof spanId !== "string") {
          throw malformed();
        }
        checkSpan(traceId.toLowerCase(), spanId.toLowerCase());
        const name = span["name"];
        spans.push({
          traceId: traceId.toLowerCase(),
          spanId: spanId.toLowerCase(),
          name: typeof name === "string" ? name : "",
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
  let raw: RawSpan[];
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
