import { describe, expect, it } from "vitest";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SpanKind, SpanStatusCode, context, trace } from "@opentelemetry/api";
import { listen } from "../http/server.js";
import { listSpansByTrace } from "../telemetry/spans.js";
import { parseOtlpBatch } from "../telemetry/otlp.js";
import { registerAgentsOn, tempDbPath } from "./test-support.js";

const TRACES_PATH = "/otel/v1/traces";

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Length-delimited field helper for hand-encoded OTLP payloads. */
function field(n: number, payload: Uint8Array): Uint8Array {
  return concat(varint((n << 3) | 2), varint(payload.length), payload);
}

/** Varint-wire field helper (kind, status code, bool/int values). */
function vfield(n: number, value: bigint): Uint8Array {
  return concat(varint((n << 3) | 0), varintBytes(value));
}

/** fixed64-wire field helper (start/end timestamps). */
function f64field(n: number, value: bigint): Uint8Array {
  return concat(varint((n << 3) | 1), fixed64Bytes(value));
}

function varint(value: number): Uint8Array {
  const out: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return new Uint8Array(out);
}

/** 64-bit varint bytes for values past 2^53. */
function varintBytes(value: bigint): Uint8Array {
  const out: number[] = [];
  let v = value;
  for (;;) {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) b |= 0x80;
    out.push(b);
    if (v === 0n) return new Uint8Array(out);
  }
}

/** Little-endian fixed64 bytes for timestamps. */
function fixed64Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = value;
  for (let i = 0; i < 8; i += 1) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function kvString(key: string, value: string): Uint8Array {
  return concat(field(1, utf8(key)), field(2, concat(field(1, utf8(value)))));
}

/** A rich span exercising every preserved field and value variant. */
function richSpanBytes(): Uint8Array {
  const traceId = new Uint8Array(16).fill(0xcc);
  const spanId = new Uint8Array(8).fill(0xdd);
  const parent = new Uint8Array(8).fill(0xee);
  // Attributes: string, bool, big int64, double, array, kvlist, bytes.
  // KeyValue entries repeat field 9 directly (no wrapper message).
  const attrs = concat(
    field(9, kvString("http.method", "GET")),
    field(9, concat(field(1, utf8("ok")), field(2, vfield(2, 1n)))),
    field(9, concat(field(1, utf8("big")), field(2, vfield(3, 1n << 60n)))),
    field(
      9,
      concat(
        field(1, utf8("ratio")),
        field(2, f64field(4, 0x3fe0000000000000n)),
      ),
    ),
    field(
      9,
      concat(
        field(1, utf8("tags")),
        field(
          2,
          field(
            5,
            concat(
              field(1, concat(field(1, utf8("a")))),
              field(1, concat(vfield(3, 42n))),
            ),
          ),
        ),
      ),
    ),
    field(
      9,
      concat(
        field(1, utf8("meta")),
        field(
          2,
          field(
            6,
            field(1, concat(field(1, utf8("k")), field(2, vfield(2, 0n)))),
          ),
        ),
      ),
    ),
    field(
      9,
      concat(
        field(1, utf8("blob")),
        field(2, field(7, new Uint8Array([1, 2, 3]))),
      ),
    ),
  );
  const span = concat(
    field(1, traceId),
    field(2, spanId),
    field(4, parent),
    field(5, utf8("rich")),
    vfield(6, 2n), // SPAN_KIND_SERVER
    f64field(7, 1770000000123000000n),
    f64field(8, 1770000000456000000n),
    attrs,
    field(15, concat(vfield(2, 2n), field(3, utf8("boom")))),
  );
  const scopeSpans = concat(
    field(1, concat(field(1, utf8("lib")), field(2, utf8("9.9")))),
    field(2, span),
  );
  const resourceSpans = concat(
    field(1, concat(field(2, kvString("service.name", "svc")))),
    field(2, scopeSpans),
  );
  return field(1, resourceSpans);
}

describe("OTel span storage (component 24)", () => {
  it("ingests a real distributed trace without destroying OTel semantics", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-spans-"),
      telemetryBatchFlushMs: 25,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const exporter = new OTLPTraceExporter({
        url: `${app.url}${TRACES_PATH}`,
        headers: { authorization: `Bearer ${agent.token}` },
        concurrencyLimit: 1,
      });
      const provider = new NodeTracerProvider({
        resource: resourceFromAttributes({ "service.name": "trace-test" }),
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });
      try {
        const tracer = provider.getTracer("trace-lib", "1.0.0");
        const root = tracer.startSpan("root", {
          kind: SpanKind.SERVER,
          attributes: { "http.method": "GET" },
        });
        root.setStatus({ code: SpanStatusCode.ERROR, message: "root failed" });
        const rootCtx = trace.setSpan(context.active(), root);
        const child1 = tracer.startSpan(
          "child-1",
          { kind: SpanKind.CLIENT, attributes: { "db.rows": 7 } },
          rootCtx,
        );
        child1.addEvent("cache.miss");
        child1.end();
        const child2 = tracer.startSpan(
          "child-2",
          { attributes: { ok: true } },
          rootCtx,
        );
        child2.end();
        root.end();
        await provider.forceFlush();
      } finally {
        await provider.shutdown();
      }

      await waitFor(() => {
        const rows = app
          .db!.prepare("SELECT COUNT(*) AS n FROM otel_spans")
          .get() as { n: number };
        return rows.n === 3;
      });
      // The trace id is SDK-generated; find it via any span.
      const all = app
        .db!.prepare("SELECT DISTINCT trace_id AS id FROM otel_spans")
        .all() as Array<{ id: string }>;
      expect(all).toHaveLength(1);
      const traceId = all[0].id;
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);

      await waitFor(() => listSpansByTrace(app.db!, traceId).length === 3);
      const stored = listSpansByTrace(app.db!, traceId);
      const byName = Object.fromEntries(stored.map((s) => [s.name, s]));

      // IDs, parents, timestamps, attributes — unchanged.
      expect(byName["root"].parentSpanId).toBeNull();
      expect(byName["child-1"].parentSpanId).toBe(byName["root"].spanId);
      expect(byName["child-2"].parentSpanId).toBe(byName["root"].spanId);
      // Stored kinds are OTLP wire numbers (SERVER=2, CLIENT=3), not the
      // JS API enum (SERVER=1, CLIENT=2): the exporter shifts by one.
      expect(byName["root"].kind).toBe(2);
      expect(byName["child-1"].kind).toBe(3);
      expect(byName["root"].statusCode).toBe(SpanStatusCode.ERROR);
      expect(byName["root"].statusMessage).toBe("root failed");
      expect(byName["child-1"].statusCode).toBe(SpanStatusCode.UNSET);
      for (const s of stored) {
        expect(s.startTimeUnixNano).toMatch(/^\d+$/);
        expect(s.endTimeUnixNano).toMatch(/^\d+$/);
        expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(
          true,
        );
      }
      expect(
        BigInt(byName["root"].startTimeUnixNano) <=
          BigInt(byName["child-1"].startTimeUnixNano),
      ).toBe(true);
      const rootAttrs = Object.fromEntries(
        byName["root"].attributes.map((a) => [a.key, a.value]),
      );
      expect(rootAttrs["http.method"]).toEqual({ stringValue: "GET" });
      const childAttrs = Object.fromEntries(
        byName["child-1"].attributes.map((a) => [a.key, a.value]),
      );
      expect(childAttrs["db.rows"]).toEqual({ intValue: "7" });
      // Resource + scope preserved; agent promoted from auth identity.
      for (const s of stored) {
        expect(s.resourceAttributes).toContainEqual({
          key: "service.name",
          value: { stringValue: "trace-test" },
        });
        expect(s.scope).toEqual({ name: "trace-lib", version: "1.0.0" });
        expect(s.agentId).toBe(agent.agentId);
      }
    } finally {
      await app.close();
    }
  }, 60000);

  it("protobuf and JSON decoders agree on rich shapes", () => {
    const fromProto = parseOtlpBatch(
      "application/x-protobuf",
      richSpanBytes(),
      500,
    );
    expect(fromProto.spans).toHaveLength(1);
    const span = fromProto.spans[0];
    expect(span.traceId).toBe("cc".repeat(16));
    expect(span.spanId).toBe("dd".repeat(8));
    expect(span.parentSpanId).toBe("ee".repeat(8));
    expect(span.name).toBe("rich");
    expect(span.kind).toBe(2);
    expect(span.startTimeUnixNano).toBe("1770000000123000000");
    expect(span.endTimeUnixNano).toBe("1770000000456000000");
    expect(span.statusCode).toBe(2);
    expect(span.statusMessage).toBe("boom");
    expect(span.attributes).toEqual([
      { key: "http.method", value: { stringValue: "GET" } },
      { key: "ok", value: { boolValue: true } },
      { key: "big", value: { intValue: String(1n << 60n) } },
      { key: "ratio", value: { doubleValue: 0.5 } },
      {
        key: "tags",
        value: {
          arrayValue: {
            values: [{ stringValue: "a" }, { intValue: "42" }],
          },
        },
      },
      {
        key: "meta",
        value: {
          kvlistValue: { values: [{ key: "k", value: { boolValue: false } }] },
        },
      },
      { key: "blob", value: { bytesValue: "AQID" } },
    ]);
    expect(span.resourceAttributes).toEqual([
      { key: "service.name", value: { stringValue: "svc" } },
    ]);
    expect(span.scope).toEqual({ name: "lib", version: "9.9" });

    // The equivalent protojson document decodes to the same span.
    const equivalent = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "svc" } },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "lib", version: "9.9" },
              spans: [
                {
                  traceId: "cc".repeat(16),
                  spanId: "dd".repeat(8),
                  parentSpanId: "ee".repeat(8),
                  name: "rich",
                  kind: "SPAN_KIND_SERVER",
                  startTimeUnixNano: "1770000000123000000",
                  endTimeUnixNano: "1770000000456000000",
                  status: { code: "STATUS_CODE_ERROR", message: "boom" },
                  attributes: [
                    { key: "http.method", value: { stringValue: "GET" } },
                    { key: "ok", value: { boolValue: true } },
                    {
                      key: "big",
                      value: { intValue: String(1n << 60n) },
                    },
                    { key: "ratio", value: { doubleValue: 0.5 } },
                    {
                      key: "tags",
                      value: {
                        arrayValue: {
                          values: [{ stringValue: "a" }, { intValue: "42" }],
                        },
                      },
                    },
                    {
                      key: "meta",
                      value: {
                        kvlistValue: {
                          values: [{ key: "k", value: { boolValue: false } }],
                        },
                      },
                    },
                    { key: "blob", value: { bytesValue: "AQID" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const fromJson = parseOtlpBatch(
      "application/json",
      new TextEncoder().encode(JSON.stringify(equivalent)),
      500,
    );
    expect(fromJson.spans).toEqual(fromProto.spans);
  });
});
