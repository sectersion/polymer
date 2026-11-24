import { describe, expect, it } from "vitest";
import { ExportResultCode } from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { listen } from "../http/server.js";
import { parseOtlpBatch } from "../telemetry/otlp.js";
import { registerAgentsOn, tempDbPath } from "./test-support.js";

const TRACES_PATH = "/otel/v1/traces";

function postTraces(
  url: string,
  init: {
    token?: string;
    contentType?: string;
    body?: string | Uint8Array;
    method?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) {
    headers["authorization"] = `Bearer ${init.token}`;
  }
  if (init.contentType !== undefined) {
    headers["content-type"] = init.contentType;
  }
  return fetch(`${url}${TRACES_PATH}`, {
    method: init.method ?? "POST",
    headers,
    body: init.body,
  });
}

const VALID_JSON_BATCH = JSON.stringify({
  resourceSpans: [
    {
      resource: { attributes: [] },
      scopeSpans: [
        {
          scope: { name: "test-lib" },
          spans: [
            {
              traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              spanId: "bbbbbbbbbbbbbbbb",
              name: "test-span",
              kind: 1,
              startTimeUnixNano: "1770000000123000000",
              endTimeUnixNano: "1770000001456000000",
            },
          ],
        },
      ],
    },
  ],
});

/** Minimal hand-encoded ExportTraceServiceRequest (field numbers per
 * the public OTLP proto): one span, 16-byte trace id of 0x01, 8-byte
 * span id of 0x02, name "x". */
function handEncodedSpan(): Uint8Array {
  const traceId = new Uint8Array(16).fill(1);
  const spanId = new Uint8Array(8).fill(2);
  const name = new TextEncoder().encode("x");
  const span = concat(field(1, traceId), field(2, spanId), field(5, name));
  const scopeSpans = field(2, span);
  const resourceSpans = field(2, scopeSpans);
  return field(1, resourceSpans);
}

function field(n: number, payload: Uint8Array): Uint8Array {
  return concat(varint((n << 3) | 2), varint(payload.length), payload);
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

/** A real OpenTelemetry client pointed at the Polymer endpoint.
 * Returns the exporter result codes so the test asserts on the
 * actual HTTP outcome, not just the absence of a throw. */
async function exportViaRealClient(
  url: string,
  token: string,
  spanCount: number,
): Promise<ExportResultCode[]> {
  const exporter = new OTLPTraceExporter({
    url: `${url}${TRACES_PATH}`,
    headers: { authorization: `Bearer ${token}` },
    concurrencyLimit: 1,
  });
  const codes: ExportResultCode[] = [];
  const inner = exporter.export.bind(exporter);
  exporter.export = (items, callback) =>
    inner(items, (result) => {
      codes.push(result.code);
      callback(result);
    });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "polymer-test-client",
      // Identity can be claimed by anyone in telemetry attributes;
      // the server must ignore it (Bearer principal is authoritative).
      "polymer.agent_id": "00000000-0000-4000-8000-000000000000",
    }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  try {
    const tracer = provider.getTracer("test-tracer", "1.0.0");
    for (let i = 0; i < spanCount; i += 1) {
      const span = tracer.startSpan(`span-${i}`, {
        attributes: { "test.index": i },
      });
      span.end();
    }
    await provider.forceFlush();
  } finally {
    await provider.shutdown();
  }
  return codes;
}

describe("OTLP receiver (component 22)", () => {
  it("accepts a real OpenTelemetry client batch", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      // Two spans in one flush; resource attributes inside claim a
      // bogus agent id — acceptance must not depend on them.
      const first = await exportViaRealClient(app.url, agent.token, 2);
      expect(first.length).toBeGreaterThan(0);
      expect(first.every((c) => c === ExportResultCode.SUCCESS)).toBe(true);
      // The batch above would 400/401/413 on any validation failure
      // (non-2xx export results land in `codes`); a second accepted
      // batch proves the endpoint stays healthy.
      const second = await exportViaRealClient(app.url, agent.token, 1);
      expect(second.every((c) => c === ExportResultCode.SUCCESS)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("rejects bad or missing credentials with 401 invalid_token", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
    });
    try {
      await registerAgentsOn(app, ["otel-agent"]);
      for (const token of [undefined, "bogus-token", "deadbeef.cafe"]) {
        const res = await postTraces(app.url, {
          token,
          contentType: "application/json",
          body: VALID_JSON_BATCH,
        });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "invalid_token" });
      }
    } finally {
      await app.close();
    }
  });

  it("invalid OTLP Bearers are IP-budgeted: 401 until the budget is spent, then 429", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
      mcpRateLimitPerMin: 3,
    });
    try {
      const post = () =>
        postTraces(app.url, {
          token: "deadbeef.cafe",
          contentType: "application/json",
          body: VALID_JSON_BATCH,
        });
      for (let i = 0; i < 3; i++) {
        expect((await post()).status).toBe(401);
      }
      const limited = await post();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        error: "rate_limit_exceeded",
        retry_after: 60,
      });
    } finally {
      await app.close();
    }
  });

  it("valid OTLP posts do not consume the IP budget", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
      mcpRateLimitPerMin: 20,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      // Far more valid posts than the IP cap: each is refunded.
      for (let i = 0; i < 40; i++) {
        const res = await postTraces(app.url, {
          token: agent.token,
          contentType: "application/json",
          body: VALID_JSON_BATCH,
        });
        expect(res.status).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects wrong content types and malformed payloads with 400", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const post = (
        contentType: string | undefined,
        body?: string | Uint8Array,
      ) =>
        postTraces(app.url, {
          token: agent.token,
          contentType,
          body,
        });

      const wrongType = await post("text/plain", VALID_JSON_BATCH);
      expect(wrongType.status).toBe(400);
      expect(await wrongType.json()).toEqual({ error: "invalid_request" });

      const missingType = await post(undefined, VALID_JSON_BATCH);
      expect(missingType.status).toBe(400);

      const notJson = await post("application/json", "this is not json{");
      expect(notJson.status).toBe(400);

      const zeroTrace = await post(
        "application/json",
        JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "00000000000000000000000000000000",
                      spanId: "bbbbbbbbbbbbbbbb",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );
      expect(zeroTrace.status).toBe(400);

      const truncated = await post(
        "application/x-protobuf",
        new Uint8Array([0x0a]),
      );
      expect(truncated.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("rejects oversized requests with 413", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
      telemetryMaxRequestBytes: 64,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const res = await postTraces(app.url, {
        token: agent.token,
        contentType: "application/json",
        body: VALID_JSON_BATCH,
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    } finally {
      await app.close();
    }
  });

  it("rejects over-count batches with 413", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
      telemetryBatchMaxSpans: 2,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const spans = [0, 1, 2].map((i) => ({
        traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        spanId: `bbbbbbbbbbbbbb${i.toString(16).padStart(2, "0")}`,
        name: `span-${i}`,
      }));
      const res = await postTraces(app.url, {
        token: agent.token,
        contentType: "application/json",
        body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
      });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    } finally {
      await app.close();
    }
  });

  it("answers 405 off-method, 404 disabled, and ignores other paths", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const get = await postTraces(app.url, {
        token: agent.token,
        method: "GET",
      });
      expect(get.status).toBe(405);

      const other = await fetch(`${app.url}/otel/v1/metrics`, {
        method: "POST",
        headers: { authorization: `Bearer ${agent.token}` },
      });
      expect(other.status).toBe(404);
    } finally {
      await app.close();
    }

    const off = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
      telemetryEnabled: false,
    });
    try {
      const [agent] = await registerAgentsOn(off, ["otel-agent"]);
      const res = await postTraces(off.url, {
        token: agent.token,
        contentType: "application/json",
        body: VALID_JSON_BATCH,
      });
      expect(res.status).toBe(404);
    } finally {
      await off.close();
    }
  });

  it("accepts an empty batch and charset-suffixed content types", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const empty = await postTraces(app.url, {
        token: agent.token,
        contentType: "application/x-protobuf",
        body: new Uint8Array(0),
      });
      expect(empty.status).toBe(200);

      const charset = await postTraces(app.url, {
        token: agent.token,
        contentType: "application/json; charset=utf-8",
        body: VALID_JSON_BATCH,
      });
      expect(charset.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("parses hand-encoded protobuf and JSON shapes identically", () => {
    const fromProto = parseOtlpBatch(
      "application/x-protobuf",
      handEncodedSpan(),
      500,
    );
    expect(fromProto.spans).toEqual([
      {
        traceId: "01010101010101010101010101010101",
        spanId: "0202020202020202",
        parentSpanId: null,
        name: "x",
        kind: 0,
        startTimeUnixNano: "0",
        endTimeUnixNano: "0",
        statusCode: 0,
        statusMessage: null,
        attributes: [],
        resourceAttributes: [],
        scope: { name: "", version: "" },
      },
    ]);

    const fromJson = parseOtlpBatch(
      "application/json",
      new TextEncoder().encode(
        JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "01010101010101010101010101010101",
                      spanId: "0202020202020202",
                      name: "x",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
      500,
    );
    expect(fromJson.spans).toEqual(fromProto.spans);

    // Uppercase hex is accepted (decoders must not be case-sensitive).
    const upper = parseOtlpBatch(
      "application/json",
      new TextEncoder().encode(
        JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                      spanId: "BBBBBBBBBBBBBBBB",
                    },
                  ],
                },
              ],
            },
          ],
        }),
      ),
      500,
    );
    expect(upper.spans[0].traceId).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

/** Decode-bound helpers (issue #156, part A). */
const TRACE = "a".repeat(32);
const pbBytes = (s: string) => new TextEncoder().encode(s);

function pbSpanBytes(i: number, attrValue?: Uint8Array): Uint8Array {
  const parts = [
    field(1, new Uint8Array(16).fill(1)),
    field(2, new Uint8Array(8).fill((i % 250) + 1)),
  ];
  if (attrValue !== undefined) {
    parts.push(field(9, concat(field(1, pbBytes("k")), field(2, attrValue))));
  }
  return concat(...parts);
}

/** One resourceSpans holding one scopeSpans block per entry. */
function pbRequest(blocks: Uint8Array[][]): Uint8Array {
  const scopes = blocks.map((spans) =>
    field(2, concat(...spans.map((s) => field(2, s)))),
  );
  return field(1, concat(...scopes));
}

/** AnyValue: `levels` nested wrappers around a string leaf. */
function pbNested(levels: number, kind: "array" | "kvlist"): Uint8Array {
  let v = field(1, pbBytes("x"));
  for (let i = 0; i < levels; i += 1) {
    v =
      kind === "array"
        ? field(5, field(1, v))
        : field(6, field(1, concat(field(1, pbBytes("k")), field(2, v))));
  }
  return v;
}

/** Same as pbNested(array) but linear time, for ~1 MiB payloads. */
function pbNestedArrayLarge(levels: number): Uint8Array {
  const prefixes: Uint8Array[] = [];
  let size = 3; // leaf: tag, len, "x"
  for (let i = 0; i < levels; i += 1) {
    const itemPrefix = concat(new Uint8Array([0x0a]), varint(size));
    const arrLen = itemPrefix.length + size;
    const arrPrefix = concat(new Uint8Array([0x2a]), varint(arrLen));
    prefixes.push(concat(arrPrefix, itemPrefix));
    size = arrPrefix.length + arrLen;
  }
  const out = new Uint8Array(size);
  let pos = 0;
  for (let i = levels - 1; i >= 0; i -= 1) {
    out.set(prefixes[i]!, pos);
    pos += prefixes[i]!.length;
  }
  out.set(field(1, pbBytes("x")), pos);
  return out;
}

function jsonNested(
  levels: number,
  kind: "array" | "kvlist" | "mixed",
): unknown {
  let v: unknown = { stringValue: "x" };
  for (let i = 0; i < levels; i += 1) {
    const useKv = kind === "kvlist" || (kind === "mixed" && i % 2 === 0);
    v = useKv
      ? { kvlistValue: { values: [{ key: "k", value: v }] } }
      : { arrayValue: { values: [v] } };
  }
  return v;
}

function jsonSpan(i: number, value?: unknown): Record<string, unknown> {
  return {
    traceId: TRACE,
    spanId: `bbbbbbbbbbbb${i.toString(16).padStart(4, "0")}`,
    ...(value === undefined ? {} : { attributes: [{ key: "k", value }] }),
  };
}

function jsonBatch(spans: unknown[]): Uint8Array {
  return pbBytes(
    JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans }] }] }),
  );
}

const jsonAttr = (levels: number, kind: "array" | "kvlist" | "mixed") =>
  jsonBatch([jsonSpan(1, jsonNested(levels, kind))]);

function outcome(fn: () => unknown): string {
  try {
    fn();
    return "ok";
  } catch (err) {
    return err instanceof Error && "code" in err
      ? String((err as { code: unknown }).code)
      : `unexpected:${String(err)}`;
  }
}

const parseProto = (b: Uint8Array, max = 500) =>
  outcome(() => parseOtlpBatch("application/x-protobuf", b, max));
const parseJson = (b: Uint8Array, max = 500) =>
  outcome(() => parseOtlpBatch("application/json", b, max));

describe("OTLP decode bounds (#156 part A)", () => {
  it("span count: exactly maxSpans passes, maxSpans+1 is payload_too_large (protobuf and JSON)", () => {
    const pb = (n: number) =>
      pbRequest([Array.from({ length: n }, (_, i) => pbSpanBytes(i))]);
    const js = (n: number) =>
      jsonBatch(Array.from({ length: n }, (_, i) => jsonSpan(i)));
    expect(parseProto(pb(3), 3)).toBe("ok");
    expect(parseProto(pb(4), 3)).toBe("payload_too_large");
    expect(parseJson(js(3), 3)).toBe("ok");
    expect(parseJson(js(4), 3)).toBe("payload_too_large");
  });

  it("span count is one total across resource and scope nesting", () => {
    const blocks = [
      [pbSpanBytes(1), pbSpanBytes(2)],
      [pbSpanBytes(3), pbSpanBytes(4)],
    ];
    expect(parseProto(pbRequest(blocks), 4)).toBe("ok");
    expect(parseProto(pbRequest(blocks), 3)).toBe("payload_too_large");
    const scope = (a: number, b: number) => ({
      spans: [jsonSpan(a), jsonSpan(b)],
    });
    const body = pbBytes(
      JSON.stringify({
        resourceSpans: [
          { scopeSpans: [scope(1, 2), scope(3, 4)] },
          { scopeSpans: [scope(5, 6)] },
        ],
      }),
    );
    expect(parseJson(body, 6)).toBe("ok");
    expect(parseJson(body, 5)).toBe("payload_too_large");
  });

  it("a malformed span past the limit still answers payload_too_large: it is never decoded", () => {
    const bad = new Uint8Array([0x0a, 0x00]); // empty trace id: malformed
    // Same scopeSpans block: caught by the payload-collection check.
    expect(
      parseProto(pbRequest([[pbSpanBytes(1), pbSpanBytes(2), bad]]), 2),
    ).toBe("payload_too_large");
    // Later scopeSpans block: reaches decodeSpan, which must throw first.
    expect(
      parseProto(pbRequest([[pbSpanBytes(1), pbSpanBytes(2)], [bad]]), 2),
    ).toBe("payload_too_large");
    // Control: the same malformed span within the limit is a 400.
    expect(parseProto(pbRequest([[pbSpanBytes(1), bad]]), 2)).toBe(
      "invalid_request",
    );
    const badJson = { traceId: "nope", spanId: "nope" };
    expect(parseJson(jsonBatch([jsonSpan(1), jsonSpan(2), badJson]), 2)).toBe(
      "payload_too_large",
    );
    expect(parseJson(jsonBatch([jsonSpan(1), badJson]), 2)).toBe(
      "invalid_request",
    );
  });

  it("depth 32 passes and depth 33 is invalid_request, for arrays, kvlists and mixes, in both formats", () => {
    for (const kind of ["array", "kvlist"] as const) {
      expect(
        parseProto(pbRequest([[pbSpanBytes(1, pbNested(32, kind))]])),
      ).toBe("ok");
      expect(
        parseProto(pbRequest([[pbSpanBytes(1, pbNested(33, kind))]])),
      ).toBe("invalid_request");
    }
    for (const kind of ["array", "kvlist", "mixed"] as const) {
      expect(parseJson(jsonAttr(32, kind))).toBe("ok");
      expect(parseJson(jsonAttr(33, kind))).toBe("invalid_request");
    }
    // Resource attributes are bounded too.
    const resource = pbBytes(
      JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "k", value: jsonNested(33, "array") }],
            },
            scopeSpans: [],
          },
        ],
      }),
    );
    expect(parseJson(resource)).toBe("invalid_request");
  });

  it("depth is threaded explicitly: a wide array is fine, a deep chain is not (guards the bare .map(decode) form, which passes the index as depth)", () => {
    // Bare form: depth := element index, so element 40 would be rejected
    // while an arbitrarily deep single-element chain (index 0) would pass.
    const wide = {
      arrayValue: {
        values: Array.from({ length: 40 }, () => ({ stringValue: "x" })),
      },
    };
    expect(parseJson(jsonBatch([jsonSpan(1, wide)]))).toBe("ok");
    expect(parseJson(jsonAttr(33, "array"))).toBe("invalid_request");
    expect(parseJson(jsonAttr(200, "array"))).toBe("invalid_request");
  });

  it("a ~1 MiB deeply nested protobuf payload trips the depth cap, not the stack", () => {
    const value = pbNestedArrayLarge(100_000);
    expect(value.length).toBeGreaterThan(500_000);
    const body = pbRequest([[pbSpanBytes(1, value)]]);
    expect(parseProto(body)).toBe("invalid_request");
  });

  it("over HTTP: 50,000-deep JSON and ~4000-deep input are 400, never 500, and intake stays healthy", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const post = (contentType: string, body: Uint8Array) =>
        postTraces(app.url, { token: agent.token, contentType, body });
      const deepJson = (levels: number) =>
        new TextEncoder().encode(
          `{"resourceSpans":[{"scopeSpans":[{"spans":[{"traceId":"${TRACE}","spanId":"bbbbbbbbbbbbbbbb","attributes":[{"key":"k","value":` +
            `{"arrayValue":{"values":[`.repeat(levels) +
            `{"stringValue":"x"}` +
            `]}}`.repeat(levels) +
            `}]}]}]}]}`,
        );
      for (const levels of [4000, 50_000]) {
        const res = await post("application/json", deepJson(levels));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid_request" });
      }
      const proto = await post(
        "application/x-protobuf",
        pbRequest([[pbSpanBytes(1, pbNested(4000, "array"))]]),
      );
      expect(proto.status).toBe(400);
      const ok = await post("application/json", jsonBatch([jsonSpan(1)]));
      expect(ok.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("over HTTP: protobuf maxSpans+1 answers 413 payload_too_large", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-otel-"),
      telemetryBatchMaxSpans: 2,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["otel-agent"]);
      const post = (n: number) =>
        postTraces(app.url, {
          token: agent.token,
          contentType: "application/x-protobuf",
          body: pbRequest([
            Array.from({ length: n }, (_, i) => pbSpanBytes(i)),
          ]),
        });
      expect((await post(2)).status).toBe(200);
      const over = await post(3);
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({ error: "payload_too_large" });
    } finally {
      await app.close();
    }
  });
});
