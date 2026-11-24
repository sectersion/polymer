import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "../http/server.js";
import { MAX_LOG_RECORDS_SCANNED, parseOtlpLogs } from "../telemetry/logs.js";
import { OtelError } from "../telemetry/otlp.js";
import { TelemetryQueue } from "../telemetry/queue.js";
import { registerAgentsOn, tempDbPath } from "./test-support.js";

const fixture = readFileSync(
  new URL("./fixtures/claude-code-logs.json", import.meta.url),
  "utf8",
);
const CANARY = "CANARY-PROMPT-TEXT-7f3a";

type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, v: string): Attr => ({
  key,
  value: { stringValue: v },
});
const n = (key: string, v: number | string): Attr => ({
  key,
  value: { intValue: v },
});

function apiRequest(opts: {
  seq?: number | null;
  session?: string | null;
  ts?: string | null;
  model?: string;
  input?: number;
  cost?: number | null;
  extra?: Attr[];
}): Record<string, unknown> {
  const attrs: Attr[] = [
    s("event.name", "api_request"),
    s("model", opts.model ?? "fake-model"),
    n("input_tokens", opts.input ?? 10),
    n("output_tokens", 2),
    { key: "cost_usd", value: { doubleValue: 0.5 } },
    ...(opts.extra ?? []),
  ];
  if (opts.cost !== null) attrs.push(n("cost_usd_micros", opts.cost ?? 500));
  if (opts.session !== null) {
    attrs.push(s("session.id", opts.session ?? "fake-session-a"));
  }
  if (opts.seq !== null) attrs.push(n("event.sequence", opts.seq ?? 1));
  if (opts.ts !== null) {
    attrs.push(s("event.timestamp", opts.ts ?? "2023-11-14T22:13:20.000Z"));
  }
  return { attributes: attrs };
}

const noise = (i: number): Record<string, unknown> => ({
  attributes: [
    s("event.name", "tool_result"),
    n("event.sequence", i),
    s("tool_parameters", CANARY),
  ],
});

const logsBody = (records: Array<Record<string, unknown>>): string =>
  JSON.stringify({
    resourceLogs: [{ scopeLogs: [{ logRecords: records }] }],
  });

// --- minimal protobuf encoder (tests only) ---
const cat = (...p: Uint8Array[]): Uint8Array => Buffer.concat(p);
function varint(v: number): Uint8Array {
  const out: number[] = [];
  let x = v;
  while (x > 0x7f) {
    out.push((x & 0x7f) | 0x80);
    x = Math.floor(x / 128);
  }
  out.push(x);
  return Uint8Array.from(out);
}
const ld = (field: number, payload: Uint8Array): Uint8Array =>
  cat(varint((field << 3) | 2), varint(payload.length), payload);
const pbStr = (v: string): Uint8Array => ld(1, Buffer.from(v));
const pbInt = (v: number): Uint8Array => cat(varint(3 << 3), varint(v));
const pbKv = (key: string, anyValue: Uint8Array): Uint8Array =>
  ld(6, cat(ld(1, Buffer.from(key)), ld(2, anyValue)));
function pbLogs(records: Uint8Array[]): Uint8Array {
  const sl = cat(...records.map((r) => ld(2, r)));
  return ld(1, ld(2, sl));
}

describe("OTLP logs decoder (#159)", () => {
  it("keeps only api_request usage fields from the real-shape fixture", () => {
    const { events } = parseOtlpLogs(
      "application/json",
      Buffer.from(fixture),
      500,
    );
    expect(events).toEqual([
      {
        model: "fake-model",
        inputTokens: 1000,
        outputTokens: 20,
        cacheReadTokens: 300,
        cacheCreationTokens: 40,
        costMicroUsd: 12346,
        sessionId: "fake-session-0001",
        sequence: 26,
        timestamp: "2023-11-14T22:13:21.000Z",
      },
    ]);
  });

  it("decodes protobuf identically and ignores the double cost_usd", () => {
    const rec = cat(
      pbKv("event.name", pbStr("api_request")),
      pbKv("tool_parameters", pbStr(CANARY)),
      pbKv("model", pbStr("fake-model")),
      pbKv("input_tokens", pbInt(7)),
      pbKv("cost_usd", cat(Uint8Array.of((4 << 3) | 1), new Uint8Array(8))),
      pbKv("cost_usd_micros", pbInt(99)),
      pbKv("session.id", pbStr("fake-session-a")),
      pbKv("event.sequence", pbInt(3)),
      pbKv("event.timestamp", pbStr("2023-11-14T22:13:20.000Z")),
    );
    const other = pbKv("event.name", pbStr("user_prompt"));
    const { events } = parseOtlpLogs(
      "application/x-protobuf",
      pbLogs([other, rec]),
      500,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      model: "fake-model",
      inputTokens: 7,
      outputTokens: null,
      costMicroUsd: 99,
      sequence: 3,
    });
  });

  it("a double or garbage cost_usd_micros is null, never rounded", () => {
    const body = logsBody([
      {
        attributes: [
          s("event.name", "api_request"),
          { key: "cost_usd_micros", value: { doubleValue: 12.5 } },
          n("input_tokens", "-4"),
        ],
      },
    ]);
    const { events } = parseOtlpLogs(
      "application/json",
      Buffer.from(body),
      500,
    );
    expect(events[0]).toMatchObject({ costMicroUsd: null, inputTokens: null });
  });

  it("caps KEPT events at maxEvents, scanned records separately", () => {
    const five = logsBody(Array.from({ length: 5 }, () => apiRequest({})));
    const run = (max: number): unknown => {
      try {
        return parseOtlpLogs("application/json", Buffer.from(five), max);
      } catch (e) {
        return (e as OtelError).code;
      }
    };
    expect(run(5)).toMatchObject({ events: expect.any(Array) });
    expect(run(4)).toBe("payload_too_large");
    const manyNoise = logsBody(
      Array.from({ length: MAX_LOG_RECORDS_SCANNED + 1 }, (_, i) => noise(i)),
    );
    expect(() =>
      parseOtlpLogs("application/json", Buffer.from(manyNoise), 500),
    ).toThrow(OtelError);
  });

  it("never throws anything but OtelError, with no record text in the message", () => {
    for (const body of [
      `{"resourceLogs":[{"scopeLogs":[{"logRecords":["${CANARY}"]}]}]}`,
      `${CANARY}{`,
      `{"resourceLogs":"${CANARY}"}`,
    ]) {
      try {
        parseOtlpLogs("application/json", Buffer.from(body), 500);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(OtelError);
        expect(String((e as Error).message)).not.toContain(CANARY);
      }
    }
  });
});

describe("POST /otel/v1/logs (#159)", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of apps.splice(0)) await a.close();
  });

  async function setup() {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-logs-"),
      telemetryBatchFlushMs: 25,
    });
    apps.push(app);
    const [agent] = await registerAgentsOn(app, ["logs-a"]);
    const post = (
      body: string | Uint8Array,
      contentType = "application/json",
      token: string | null = agent.token,
    ) =>
      fetch(`${app.url}/otel/v1/logs`, {
        method: "POST",
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          "content-type": contentType,
        },
        body: typeof body === "string" ? body : Buffer.from(body),
      });
    const rows = (): Array<Record<string, unknown>> =>
      app
        .db!.prepare("SELECT * FROM usage_records ORDER BY rowid")
        .all() as Array<Record<string, unknown>>;
    const settle = async (want: number): Promise<void> => {
      const t = Date.now();
      while (rows().length < want && Date.now() - t < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 100));
    };
    return { app, agent, post, rows, settle };
  }

  it("the credential's agent owns the row; payload identity is ignored; money is integer micro-USD", async () => {
    const { agent, post, rows, settle } = await setup();
    const res = await post(fixture);
    expect(res.status).toBe(200);
    await settle(1);
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      agent_id: agent.agentId,
      task_id: null,
      provider: "anthropic",
      model: "fake-model",
      input_tokens: 1000,
      output_tokens: 20,
      reported_cost_micro_usd: 12346,
      cost_source: "reported",
    });
    expect(JSON.parse(r[0]!["other_token_categories"] as string)).toEqual({
      cache_read_tokens: 300,
      cache_creation_tokens: 40,
    });
  });

  it("http/protobuf through the real route: a LogRecord with time_unix_nano, flags and AnyValue-int usage yields the exact rows", async () => {
    const { agent, post, rows, settle } = await setup();
    const fixed64 = (field: number, v: bigint): Uint8Array => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64LE(v);
      return cat(varint((field << 3) | 1), b);
    };
    const fixed32 = (field: number, v: number): Uint8Array => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(v);
      return cat(varint((field << 3) | 5), b);
    };
    const rec = (seq: number, input: number, cost: number): Uint8Array =>
      cat(
        fixed64(1, 1700000001000000000n), // time_unix_nano
        fixed64(11, 1700000001000000000n), // observed_time_unix_nano
        varint((2 << 3) | 0),
        varint(9), // severity_number
        ld(3, Buffer.from("INFO")),
        ld(5, pbStr("claude_code.api_request")), // body
        pbKv("event.name", pbStr("api_request")),
        pbKv("model", pbStr("fake-model")),
        pbKv("input_tokens", pbInt(input)),
        pbKv("output_tokens", pbInt(20)),
        pbKv("cache_read_tokens", pbInt(300)),
        pbKv("cache_creation_tokens", pbInt(40)),
        pbKv("cost_usd_micros", pbInt(cost)),
        pbKv("session.id", pbStr("fake-session-pb")),
        pbKv("event.sequence", pbInt(seq)),
        pbKv("event.timestamp", pbStr("2023-11-14T22:13:21.000Z")),
        fixed32(8, 1), // flags
      );
    const resource = ld(
      1,
      ld(
        1,
        cat(
          ld(1, Buffer.from("service.name")),
          ld(2, pbStr("fixture-service")),
        ),
      ),
    );
    const scope = ld(1, ld(1, Buffer.from("com.anthropic.claude_code.events")));
    const scopeLogs = ld(
      2,
      cat(scope, ld(2, rec(1, 1000, 12346)), ld(2, rec(2, 5, 7))),
    );
    const body = ld(1, cat(resource, scopeLogs));
    const res = await post(body, "application/x-protobuf");
    expect(res.status).toBe(200);
    await settle(2);
    const r = rows();
    expect(r).toHaveLength(2);
    expect(
      r.map((x) => [
        x["agent_id"],
        x["model"],
        x["input_tokens"],
        x["output_tokens"],
        x["reported_cost_micro_usd"],
        x["cost_source"],
        x["task_id"],
      ]),
    ).toEqual([
      [agent.agentId, "fake-model", 1000, 20, 12346, "reported", null],
      [agent.agentId, "fake-model", 5, 20, 7, "reported", null],
    ]);
    expect(JSON.parse(r[0]!["other_token_categories"] as string)).toEqual({
      cache_read_tokens: 300,
      cache_creation_tokens: 40,
    });
  });

  it("forged identity attributes never change the owner", async () => {
    const { agent, post, rows, settle } = await setup();
    const body = logsBody([
      apiRequest({
        extra: [
          s("agent_id", "someone-else"),
          s("user.id", "u-1"),
          s("user.email", "x@example.invalid"),
        ],
      }),
    ]);
    expect((await post(body)).status).toBe(200);
    await settle(1);
    expect(rows()[0]!["agent_id"]).toBe(agent.agentId);
  });

  it("(a) 1,000 noise records + 3 api_request records -> 200 and 3 rows", async () => {
    const { post, rows, settle } = await setup();
    const recs = [
      ...Array.from({ length: 1000 }, (_, i) => noise(i + 100)),
      apiRequest({ seq: 1 }),
      apiRequest({ seq: 2 }),
      apiRequest({ seq: 3 }),
    ];
    expect((await post(logsBody(recs))).status).toBe(200);
    await settle(3);
    expect(rows()).toHaveLength(3);
  });

  it("more kept api_request events than batch_max_spans -> 413", async () => {
    const { post } = await setup();
    const recs = Array.from({ length: 501 }, (_, i) => apiRequest({ seq: i }));
    expect((await post(logsBody(recs))).status).toBe(413);
  });

  it("(b) retry of the same batch writes once", async () => {
    const { post, rows, settle } = await setup();
    const body = logsBody([apiRequest({ seq: 1 })]);
    expect((await post(body)).status).toBe(200);
    await settle(1);
    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(rows()).toHaveLength(1);
  });

  it("(b) same timestamp, different sequence: both write", async () => {
    const { post, rows, settle } = await setup();
    const body = logsBody([apiRequest({ seq: 1 }), apiRequest({ seq: 2 })]);
    expect((await post(body)).status).toBe(200);
    await settle(2);
    expect(rows()).toHaveLength(2);
  });

  it("(b) same key, different content: both write (collision not ignored)", async () => {
    const { post, rows, settle } = await setup();
    const body = logsBody([
      apiRequest({ seq: 1, input: 10 }),
      apiRequest({ seq: 1, input: 11 }),
    ]);
    expect((await post(body)).status).toBe(200);
    await settle(2);
    expect(rows()).toHaveLength(2);
  });

  it("(b) missing session.id, sequence or timestamp: no idempotency, each write lands", async () => {
    const { post, rows, settle } = await setup();
    for (const missing of [{ session: null }, { seq: null }, { ts: null }]) {
      const body = logsBody([apiRequest(missing)]);
      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);
    }
    await settle(6);
    expect(rows()).toHaveLength(6);
  });

  it("missing cost_usd_micros stores NULL cost and source unknown", async () => {
    const { post, rows, settle } = await setup();
    expect((await post(logsBody([apiRequest({ cost: null })]))).status).toBe(
      200,
    );
    await settle(1);
    expect(rows()[0]).toMatchObject({
      reported_cost_micro_usd: null,
      cost_source: "unknown",
    });
  });

  it("(c) prompt text is never stored, logged or echoed, even when decode fails mid-batch", async () => {
    const { app, post, rows, settle } = await setup();
    const spies = (["log", "error", "warn", "info", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    // Good batch with a prompt-bearing noise record: stored usage only.
    const good = logsBody([
      {
        attributes: [
          s("event.name", "user_prompt"),
          s("prompt", CANARY),
          s("prompt_text", CANARY),
        ],
      },
      apiRequest({ extra: [s("prompt", CANARY)] }),
    ]);
    expect((await post(good)).status).toBe(200);
    // Batch that fails mid-decode (after a prompt-bearing record).
    const bad = `{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"attributes":[{"key":"prompt","value":{"stringValue":"${CANARY}"}}]},"${CANARY}"]}]}]}`;
    const res = await post(bad);
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(CANARY);
    // Truncated protobuf with a prompt-bearing record.
    const pb = pbLogs([
      cat(pbKv("prompt", pbStr(CANARY)), Uint8Array.of(0xff)),
    ]);
    const res2 = await post(pb, "application/x-protobuf");
    expect(res2.status).toBe(400);
    expect(await res2.text()).not.toContain(CANARY);
    await settle(1);
    const dump = JSON.stringify([
      rows(),
      app.db!.prepare("SELECT * FROM otel_spans").all(),
      app.db!.prepare("SELECT * FROM telemetry_counters").all(),
    ]);
    expect(dump).not.toContain(CANARY);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
    }
  });

  it("a usage-only batch larger than one transaction drains across chunks without loss", async () => {
    const { app, agent, rows } = await setup();
    const q = new TelemetryQueue(app.db!, { maxBatches: 5, flushMs: 60_000 });
    const usage = Array.from({ length: 1200 }, (_, i) => ({
      model: "fake-model",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costMicroUsd: 1,
      sessionId: "fake-session-q",
      sequence: i,
      timestamp: "2023-11-14T22:13:20.000Z",
    }));
    expect(
      q.enqueue({
        agentId: agent.agentId,
        spans: [],
        usage,
        receivedAt: new Date().toISOString(),
        bytes: 1200,
      }),
    ).toBe(true);
    q.flush();
    expect(rows()).toHaveLength(1200);
    expect(q.depth()).toBe(0);
    expect(q.queuedBytes()).toBe(0);
  });

  it("401 without a credential, before any decode", async () => {
    const { post } = await setup();
    expect((await post(fixture, "application/json", null)).status).toBe(401);
    expect((await post(fixture, "application/json", "bogus")).status).toBe(401);
  });

  it("a logs batch with no api_request events is 200 and stores nothing", async () => {
    const { post, rows } = await setup();
    expect((await post(logsBody([noise(1), noise(2)]))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(rows()).toHaveLength(0);
  });
});
