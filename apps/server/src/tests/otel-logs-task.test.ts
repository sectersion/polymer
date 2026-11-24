import { afterEach, describe, expect, it, vi } from "vitest";
import { listen } from "../http/server.js";
import { TelemetryQueue } from "../telemetry/queue.js";
import {
  TASK_ID_REJECTED_COUNTER,
  getTelemetryCounter,
} from "../telemetry/usage.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

const CANARY = "CANARY-CLAIM-TEXT-91c2";
type Attr = { key: string; value: Record<string, unknown> };
const s = (key: string, v: string): Attr => ({
  key,
  value: { stringValue: v },
});
const n = (key: string, v: number): Attr => ({ key, value: { intValue: v } });

let seq = 0;
function api(extra: Attr[] = []): Record<string, unknown> {
  seq += 1;
  return {
    attributes: [
      s("event.name", "api_request"),
      s("model", "fake-model"),
      n("input_tokens", 10),
      n("output_tokens", 2),
      n("cost_usd_micros", 500),
      s("session.id", "fake-session-task"),
      n("event.sequence", seq),
      s("event.timestamp", "2023-11-14T22:13:20.000Z"),
      ...extra,
    ],
  };
}
const logs = (
  records: Array<Record<string, unknown>>,
  resourceAttrs: Attr[] = [],
): string =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [{ logRecords: records }],
      },
    ],
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
const kv = (key: string, any: Uint8Array): Uint8Array =>
  cat(ld(1, Buffer.from(key)), ld(2, any));
function pbRecord(extra: Uint8Array[] = []): Uint8Array {
  seq += 1;
  return cat(
    ...[
      kv("event.name", pbStr("api_request")),
      kv("model", pbStr("fake-model")),
      kv("input_tokens", pbInt(10)),
      kv("cost_usd_micros", pbInt(500)),
      kv("session.id", pbStr("fake-session-task")),
      kv("event.sequence", pbInt(seq)),
      kv("event.timestamp", pbStr("2023-11-14T22:13:20.000Z")),
      ...extra,
    ].map((a) => ld(6, a)),
  );
}

describe("task attribution on logs usage rows (#159 PR 2)", () => {
  const apps: Array<{ close(): Promise<void> }> = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const a of apps.splice(0)) await a.close();
  });

  async function setup() {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-logs-task-"),
      telemetryBatchFlushMs: 25,
    });
    apps.push(app);
    const [a, b] = await registerAgentsOn(app, ["task-a", "task-b"]);
    const mk = async (token: string, title: string): Promise<string> =>
      withAuthedClients(app, [token], async ([c]) => {
        const t = (await c!.callTool({
          name: "create_task",
          arguments: { title },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
    const own = await mk(a.token, "a's task");
    const foreign = await mk(b.token, "b's task");
    const post = (body: string | Uint8Array, ct = "application/json") =>
      fetch(`${app.url}/otel/v1/logs`, {
        method: "POST",
        headers: { authorization: `Bearer ${a.token}`, "content-type": ct },
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
    const rejected = (): number =>
      getTelemetryCounter(app.db!, TASK_ID_REJECTED_COUNTER);
    return { app, a, b, own, foreign, post, rows, settle, rejected };
  }

  it("a record attribute naming a coordinated task attributes the row (JSON)", async () => {
    const { a, own, post, rows, settle, rejected } = await setup();
    const res = await post(logs([api([s("polymer.task_id", own)])]));
    expect(res.status).toBe(200);
    await settle(1);
    expect(rows()[0]).toMatchObject({ agent_id: a.agentId, task_id: own });
    expect(rejected()).toBe(0);
  });

  it("a resource attribute (as Claude Code copies OTEL_RESOURCE_ATTRIBUTES) attributes the row (JSON)", async () => {
    const { own, post, rows, settle } = await setup();
    const res = await post(logs([api()], [s("polymer.task_id", own)]));
    expect(res.status).toBe(200);
    await settle(1);
    expect(rows()[0]!["task_id"]).toBe(own);
  });

  it("an assigned (not coordinated) task is honored", async () => {
    const { app, a, foreign, post, rows, settle, rejected } = await setup();
    app
      .db!.prepare(
        "INSERT INTO task_assignments (task_id, agent_id) VALUES (?, ?)",
      )
      .run(foreign, a.agentId);
    expect(
      (await post(logs([api([s("polymer.task_id", foreign)])]))).status,
    ).toBe(200);
    await settle(1);
    expect(rows()[0]!["task_id"]).toBe(foreign);
    expect(rejected()).toBe(0);
  });

  it("protobuf through the route: Resource.attributes (field 1) and record attributes both attribute rows", async () => {
    const { own, post, rows, settle } = await setup();
    const resource = ld(1, ld(1, kv("polymer.task_id", pbStr(own))));
    const recordClaim = pbRecord([kv("polymer.task_id", pbStr(own))]);
    const noRecordClaim = pbRecord();
    // scope_logs BEFORE resource in the wire order: order must not matter.
    const scope = ld(2, cat(ld(2, recordClaim), ld(2, noRecordClaim)));
    const res = await post(
      ld(1, cat(scope, resource)),
      "application/x-protobuf",
    );
    expect(res.status).toBe(200);
    await settle(2);
    expect(rows().map((r) => r["task_id"])).toEqual([own, own]);
  });

  it("a claim for an unrelated task is rejected: row stored with NULL task, counter +1 per RECORD", async () => {
    const { foreign, post, rows, settle, rejected } = await setup();
    const rec = () => api([s("polymer.task_id", foreign)]);
    expect((await post(logs([rec(), rec(), rec()]))).status).toBe(200);
    await settle(3);
    expect(rows()).toHaveLength(3);
    expect(rows().every((r) => r["task_id"] === null)).toBe(true);
    expect(rejected()).toBe(3);
  });

  it("2 rejected + 1 valid in one batch -> exactly 2", async () => {
    const { own, foreign, post, rows, settle, rejected } = await setup();
    const body = logs([
      api([s("polymer.task_id", foreign)]),
      api([s("polymer.task_id", own)]),
      api([s("polymer.task_id", foreign)]),
    ]);
    expect((await post(body)).status).toBe(200);
    await settle(3);
    expect(rows().map((r) => r["task_id"])).toEqual([null, own, null]);
    expect(rejected()).toBe(2);
  });

  it("an exporter retry of a stored event does not recount a rejection", async () => {
    const { foreign, post, rows, settle, rejected } = await setup();
    const body = logs([api([s("polymer.task_id", foreign)])]);
    expect((await post(body)).status).toBe(200);
    await settle(1);
    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect(rows()).toHaveLength(1);
    expect(rejected()).toBe(1);
  });

  it("no claim -> NULL task, no rejection (as before)", async () => {
    const { post, rows, settle, rejected } = await setup();
    expect((await post(logs([api()]))).status).toBe(200);
    await settle(1);
    expect(rows()[0]!["task_id"]).toBeNull();
    expect(rejected()).toBe(0);
  });

  it("empty and non-string claims are ignored; over-long and non-UUID strings are rejected; nothing is echoed", async () => {
    const { post, rows, settle, rejected } = await setup();
    const spies = (["log", "error", "warn", "info", "debug"] as const).map(
      (m) => vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const body = logs([
      api([s("polymer.task_id", "")]), // empty: ignored
      api([n("polymer.task_id", 7)]), // not a string: ignored
      api([s("polymer.task_id", `${CANARY}-not-a-uuid`)]), // rejected
      api([s("polymer.task_id", CANARY.repeat(40))]), // over-long: rejected
    ]);
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(CANARY);
    await settle(4);
    expect(rows()).toHaveLength(4);
    expect(rows().every((r) => r["task_id"] === null)).toBe(true);
    expect(rejected()).toBe(2);
    expect(JSON.stringify(rows())).not.toContain(CANARY);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(CANARY);
    }
  });

  it("the prompt-canary guarantee still holds with claims present", async () => {
    const { own, post, rows, settle } = await setup();
    const body = logs([
      {
        attributes: [
          s("event.name", "user_prompt"),
          s("prompt", CANARY),
          s("polymer.task_id", own),
        ],
      },
      api([s("polymer.task_id", own), s("prompt", CANARY)]),
    ]);
    expect((await post(body)).status).toBe(200);
    await settle(1);
    expect(rows()).toHaveLength(1);
    expect(JSON.stringify(rows())).not.toContain(CANARY);
  });

  it("a rolled-back chunk leaves no stale counter; the retry counts once", async () => {
    const { app, a, foreign } = await setup();
    const q = new TelemetryQueue(app.db!, { maxBatches: 5, flushMs: 60_000 });
    const ev = (model: string, sequence: number) => ({
      model,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costMicroUsd: 1,
      sessionId: "fake-session-rb",
      sequence,
      timestamp: "2023-11-14T22:13:20.000Z",
      taskClaim: foreign,
      taskClaimMalformed: false,
    });
    app.db!.exec(
      `CREATE TRIGGER boom BEFORE INSERT ON usage_records
         WHEN NEW.model = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      q.enqueue({
        agentId: a.agentId,
        spans: [],
        usage: [ev("fake-model", 1), ev("boom", 2)],
        receivedAt: new Date().toISOString(),
        bytes: 10,
      }),
    ).toBe(true);
    expect(() => q.flush()).toThrow();
    const count = () =>
      (
        app.db!.prepare("SELECT COUNT(*) AS c FROM usage_records").get() as {
          c: number;
        }
      ).c;
    expect(count()).toBe(0);
    expect(getTelemetryCounter(app.db!, TASK_ID_REJECTED_COUNTER)).toBe(0);
    app.db!.exec("DROP TRIGGER boom");
    q.flush();
    expect(count()).toBe(2);
    expect(getTelemetryCounter(app.db!, TASK_ID_REJECTED_COUNTER)).toBe(2);
  });
});
