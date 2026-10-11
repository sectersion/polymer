import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import type { PolymerDatabase } from "../database/db.js";
import {
  TASK_ID_REJECTED_COUNTER,
  getTelemetryCounter,
} from "../telemetry/usage.js";
import { runTelemetryRetention } from "../telemetry/retention.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

const DAY_MS = 24 * 3600 * 1000;

function tableCounts(db: PolymerDatabase): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of [
    "agents",
    "credentials",
    "tasks",
    "task_assignments",
    "comments",
    "mentions",
    "audit_log",
  ]) {
    out[table] = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
  }
  return out;
}

function seedSpan(
  db: PolymerDatabase,
  spanId: string,
  agentId: string,
  ingestedAt: string,
): void {
  db.prepare(
    `INSERT INTO otel_spans (span_id, trace_id, agent_id, name, ingested_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(spanId, "1".repeat(32), agentId, "s", ingestedAt);
}

function seedUsage(
  db: PolymerDatabase,
  usageId: string,
  agentId: string,
  recordedAt: string,
): void {
  db.prepare(
    `INSERT INTO usage_records
       (usage_id, agent_id, task_id, trace_id, provider, model,
        input_tokens, output_tokens, other_token_categories,
        reported_cost_micro_usd, cost_source, recorded_at)
     VALUES (?, ?, NULL, NULL, NULL, NULL, 1, 1, NULL, NULL, 'unknown', ?)`,
  ).run(usageId, agentId, recordedAt);
}

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

describe("telemetry retention (component 28)", () => {
  it("prunes only eligible telemetry; coordination is untouched", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-retention-"),
      telemetryRetentionIntervalMs: 0,
    });
    try {
      const [a] = await registerAgentsOn(app, ["retention-agent"]);
      await withAuthedClients(app, [a.token], async ([c]) => {
        const t = (await c.callTool({
          name: "create_task",
          arguments: { title: "keep me" },
        })) as { structuredContent: Record<string, unknown> };
        await c.callTool({
          name: "post_comment",
          arguments: {
            task_id: t.structuredContent["task_id"] as string,
            content: "history",
          },
        });
      });
      const before = tableCounts(app.db!);
      expect(before["tasks"]).toBe(1);
      expect(before["comments"]).toBe(1);

      const now = Date.now();
      const iso = (ms: number) => new Date(ms).toISOString();
      seedSpan(
        app.db!,
        "0".repeat(15) + "1",
        a.agentId,
        iso(now - 10 * DAY_MS),
      );
      seedSpan(app.db!, "0".repeat(15) + "2", a.agentId, iso(now - 7 * DAY_MS));
      seedSpan(app.db!, "0".repeat(15) + "3", a.agentId, iso(now));
      seedUsage(app.db!, "u-old", a.agentId, iso(now - 10 * DAY_MS));
      seedUsage(app.db!, "u-edge", a.agentId, iso(now - 7 * DAY_MS));
      seedUsage(app.db!, "u-new", a.agentId, iso(now));
      app
        .db!.prepare(
          "INSERT INTO telemetry_counters (name, value) VALUES (?, ?)",
        )
        .run(TASK_ID_REJECTED_COUNTER, 3);

      const result = runTelemetryRetention(app.db!, {
        retentionDays: 7,
        nowMs: now,
      });
      expect(result).toEqual({
        spansDeleted: 1,
        usageDeleted: 1,
        iterations: 2,
        truncated: false,
      });
      // Only the strictly-older rows left; the cutoff edge stays.
      expect(
        app
          .db!.prepare("SELECT span_id FROM otel_spans ORDER BY span_id")
          .all(),
      ).toEqual([
        { span_id: "0".repeat(15) + "2" },
        { span_id: "0".repeat(15) + "3" },
      ]);
      expect(
        app
          .db!.prepare("SELECT usage_id FROM usage_records ORDER BY usage_id")
          .all(),
      ).toEqual([{ usage_id: "u-edge" }, { usage_id: "u-new" }]);
      // Counters are cumulative history, not prunable telemetry.
      expect(getTelemetryCounter(app.db!, TASK_ID_REJECTED_COUNTER)).toBe(3);
      // Coordination history is byte-identical in count.
      expect(tableCounts(app.db!)).toEqual(before);

      // Invalid windows never delete: they throw instead.
      for (const retentionDays of [0, -7, 1.5, Number.NaN]) {
        expect(() =>
          runTelemetryRetention(app.db!, { retentionDays, nowMs: now }),
        ).toThrowError("invalid_request");
      }
      expect(tableCounts(app.db!)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it("deletes incrementally within the per-transaction bound", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-retention-"),
      telemetryRetentionIntervalMs: 0,
    });
    try {
      const [a] = await registerAgentsOn(app, ["retention-agent"]);
      const old = new Date(Date.now() - 10 * DAY_MS).toISOString();
      const insert = app.db!.prepare(
        `INSERT INTO otel_spans (span_id, trace_id, agent_id, name, ingested_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      app.db!.transaction(() => {
        for (let i = 0; i < 1200; i += 1) {
          insert.run(`old-span-${i}`, "2".repeat(32), a.agentId, "s", old);
        }
      })();
      seedUsage(app.db!, "u-1", a.agentId, old);
      seedUsage(app.db!, "u-2", a.agentId, old);
      seedUsage(app.db!, "u-3", a.agentId, old);

      const first = runTelemetryRetention(app.db!, {
        retentionDays: 7,
        maxIterations: 1,
      });
      expect(first.spansDeleted).toBe(500);
      expect(first.usageDeleted).toBe(3);
      expect(first.iterations).toBe(1);
      expect(first.truncated).toBe(true);

      const second = runTelemetryRetention(app.db!, { retentionDays: 7 });
      expect(second.spansDeleted).toBe(700);
      expect(second.usageDeleted).toBe(0);
      expect(second.truncated).toBe(false);
      expect(
        (
          app.db!.prepare("SELECT COUNT(*) AS n FROM otel_spans").get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("the scheduled job sweeps without manual runs", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-retention-"),
      telemetryRetentionIntervalMs: 25,
      telemetryRetentionDays: 7,
    });
    try {
      const [a] = await registerAgentsOn(app, ["retention-agent"]);
      seedSpan(
        app.db!,
        "f".repeat(16),
        a.agentId,
        new Date(Date.now() - 10 * DAY_MS).toISOString(),
      );
      await waitFor(
        () =>
          (
            app.db!.prepare("SELECT COUNT(*) AS n FROM otel_spans").get() as {
              n: number;
            }
          ).n === 0,
      );
    } finally {
      await app.close();
    }
  });
});
