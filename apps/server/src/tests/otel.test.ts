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
        name: "x",
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
