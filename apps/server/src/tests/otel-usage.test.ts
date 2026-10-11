import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import {
  TASK_ID_REJECTED_COUNTER,
  getTelemetryCounter,
  reportedCostForTask,
  tokensConsumedByAgent,
} from "../telemetry/usage.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

const T1 = "11111111111111111111111111111111";
const T2 = "22222222222222222222222222222222";

const str = (key: string, stringValue: string) => ({
  key,
  value: { stringValue },
});
const int = (key: string, intValue: string) => ({ key, value: { intValue } });
const dbl = (key: string, doubleValue: number) => ({
  key,
  value: { doubleValue },
});
const boolean = (key: string, boolValue: boolean) => ({
  key,
  value: { boolValue },
});

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

function count(
  db: NonNullable<Awaited<ReturnType<typeof listen>>["db"]>,
  table: string,
): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;
}

describe("usage records (component 26)", () => {
  it("derives token/cost attribution from spans without touching them", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-usage-"),
      telemetryBatchFlushMs: 25,
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["usage-a", "usage-b"]);
      const ids = await withAuthedClients(
        app,
        [a.token, b.token],
        async ([ca, cb]) => {
          const taskA = (await ca.callTool({
            name: "create_task",
            arguments: { title: "agent-a work" },
          })) as { structuredContent: Record<string, unknown> };
          const taskB = (await cb.callTool({
            name: "create_task",
            arguments: { title: "agent-b work" },
          })) as { structuredContent: Record<string, unknown> };
          return {
            taskA: taskA.structuredContent["task_id"] as string,
            taskB: taskB.structuredContent["task_id"] as string,
          };
        },
      );

      const body = JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: T1,
                    spanId: "aaaaaaaaaaaaaaaa",
                    name: "inference",
                    attributes: [
                      str("gen_ai.request.model", "gpt-4o"),
                      str("gen_ai.provider.name", "openai"),
                      int("gen_ai.usage.input_tokens", "100"),
                      int("gen_ai.usage.output_tokens", "50"),
                      int("gen_ai.usage.cost_micro_usd", "2500"),
                      str("polymer.task_id", ids.taskA),
                    ],
                  },
                  {
                    traceId: T1,
                    spanId: "bbbbbbbbbbbbbbbb",
                    name: "untasked",
                    attributes: [
                      int("gen_ai.usage.input_tokens", "10"),
                      int("gen_ai.usage.output_tokens", "5"),
                      int("gen_ai.usage.cache_read_input_tokens", "4"),
                    ],
                  },
                  {
                    traceId: T2,
                    spanId: "cccccccccccccccc",
                    name: "plain",
                    attributes: [str("http.method", "GET")],
                  },
                  {
                    traceId: T2,
                    spanId: "dddddddddddddddd",
                    name: "foreign-task",
                    attributes: [
                      int("gen_ai.usage.input_tokens", "7"),
                      int("gen_ai.usage.output_tokens", "3"),
                      int("gen_ai.usage.cost_micro_usd", "199"),
                      str("polymer.task_id", ids.taskB),
                    ],
                  },
                  {
                    traceId: T2,
                    spanId: "eeeeeeeeeeeeeeee",
                    name: "float-cost",
                    attributes: [
                      int("gen_ai.usage.input_tokens", "1"),
                      int("gen_ai.usage.output_tokens", "1"),
                      dbl("gen_ai.usage.cost_micro_usd", 1.5),
                    ],
                  },
                  {
                    traceId: T2,
                    spanId: "ffffffffffffffff",
                    name: "hostile",
                    attributes: [
                      boolean("gen_ai.request.model", true),
                      int("gen_ai.usage.input_tokens", "-5"),
                      boolean("gen_ai.usage.output_tokens", false),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      const post = () =>
        fetch(`${app.url}/otel/v1/traces`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${a.token}`,
            "content-type": "application/json",
          },
          body,
        });
      expect((await post()).status).toBe(200);
      await waitFor(() => count(app.db!, "usage_records") === 5);
      expect(count(app.db!, "otel_spans")).toBe(6);

      const rows = app
        .db!.prepare(
          `SELECT usage_id, agent_id, task_id, trace_id, provider, model,
                  input_tokens, output_tokens, other_token_categories,
                  reported_cost_micro_usd, cost_source
             FROM usage_records ORDER BY recorded_at ASC, rowid ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      const byTrace = (t: string) => rows.filter((r) => r["trace_id"] === t);
      expect(rows).toHaveLength(5);

      // Task attribution: agent A coordinates taskA, so the claim holds.
      const inference = byTrace(T1).find((r) => r["model"] === "gpt-4o")!;
      expect(inference["agent_id"]).toBe(a.agentId);
      expect(inference["task_id"]).toBe(ids.taskA);
      expect(inference["provider"]).toBe("openai");
      expect(inference["input_tokens"]).toBe(100);
      expect(inference["output_tokens"]).toBe(50);
      expect(inference["reported_cost_micro_usd"]).toBe(2500);
      expect(inference["cost_source"]).toBe("reported");

      // No claim: NULL task, unknown cost source, extras categorized.
      const untasked = byTrace(T1).find((r) => r["model"] === null)!;
      expect(untasked["task_id"]).toBeNull();
      expect(untasked["cost_source"]).toBe("unknown");
      expect(untasked["reported_cost_micro_usd"]).toBeNull();
      expect(JSON.parse(untasked["other_token_categories"] as string)).toEqual({
        "gen_ai.usage.cache_read_input_tokens": 4,
      });

      // Foreign claim: NULL task, cost still reported, rejection counted.
      const foreign = byTrace(T2).find((r) => r["input_tokens"] === 7)!;
      expect(foreign["task_id"]).toBeNull();
      expect(foreign["reported_cost_micro_usd"]).toBe(199);
      expect(foreign["cost_source"]).toBe("reported");
      expect(getTelemetryCounter(app.db!, TASK_ID_REJECTED_COUNTER)).toBe(1);

      // Float cost never enters the canonical path; hostile values sanitize.
      const floatCost = byTrace(T2).find((r) => r["input_tokens"] === 1)!;
      expect(floatCost["reported_cost_micro_usd"]).toBeNull();
      expect(floatCost["cost_source"]).toBe("unknown");
      // Wrong-shaped and negative values become NULLs, never errors.
      const garbage = app
        .db!.prepare(
          `SELECT model, input_tokens, output_tokens,
                  reported_cost_micro_usd, cost_source
             FROM usage_records WHERE task_id IS NULL AND trace_id = ?
             ORDER BY rowid ASC`,
        )
        .all(T2) as Array<Record<string, unknown>>;
      const last = garbage[garbage.length - 1];
      expect(last).toMatchObject({
        model: null,
        input_tokens: null,
        output_tokens: null,
        reported_cost_micro_usd: null,
        cost_source: "unknown",
      });

      // Win-condition reads: NULLs aggregate as 0, sums are exact.
      expect(tokensConsumedByAgent(app.db!, a.agentId)).toBe(177);
      expect(tokensConsumedByAgent(app.db!, b.agentId)).toBe(0);
      expect(reportedCostForTask(app.db!, ids.taskA)).toBe(2500);
      expect(reportedCostForTask(app.db!, ids.taskB)).toBe(0);
      const total = app
        .db!.prepare(
          `SELECT COALESCE(SUM(reported_cost_micro_usd), 0) AS s
             FROM usage_records`,
        )
        .get() as { s: number };
      expect(total.s).toBe(2699);

      // Raw telemetry is untouched: gen_ai.* still on the stored span.
      const raw = app
        .db!.prepare("SELECT attributes FROM otel_spans WHERE span_id = ?")
        .get("aaaaaaaaaaaaaaaa") as { attributes: string };
      expect(JSON.parse(raw.attributes)).toContainEqual({
        key: "gen_ai.usage.input_tokens",
        value: { intValue: "100" },
      });

      // An OTLP retry of the same batch is idempotent everywhere.
      expect((await post()).status).toBe(200);
      await new Promise((r) => setTimeout(r, 300));
      expect(count(app.db!, "otel_spans")).toBe(6);
      expect(count(app.db!, "usage_records")).toBe(5);
      expect(getTelemetryCounter(app.db!, TASK_ID_REJECTED_COUNTER)).toBe(1);
    } finally {
      await app.close();
    }
  }, 60000);
});
