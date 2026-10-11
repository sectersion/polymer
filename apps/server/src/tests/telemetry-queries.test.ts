import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import { mintCredential } from "../identity/credentials.js";
import type { PolymerDatabase } from "../database/db.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

function adminCookie(db: PolymerDatabase): string {
  const { secret } = mintCredential(db, { type: "admin_session" });
  return secret;
}

function get(url: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    headers: cookie ? { cookie: `__Host-polymer_admin=${cookie}` } : {},
  });
}

interface UsageSeed {
  agentId: string;
  taskId?: string;
  traceId?: string;
  model?: string;
  provider?: string;
  input?: number;
  output?: number;
  cost?: number;
  recordedAt: string;
}

function seedUsage(db: PolymerDatabase, seeds: UsageSeed[]): void {
  const insert = db.prepare(
    `INSERT INTO usage_records
       (usage_id, agent_id, task_id, trace_id, provider, model,
        input_tokens, output_tokens, other_token_categories,
        reported_cost_micro_usd, cost_source, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const txn = db.transaction(() => {
    for (const s of seeds) {
      insert.run(
        randomUUID(),
        s.agentId,
        s.taskId ?? null,
        s.traceId ?? null,
        s.provider ?? null,
        s.model ?? null,
        s.input ?? null,
        s.output ?? null,
        s.cost ?? null,
        s.cost === undefined ? "unknown" : "reported",
        s.recordedAt,
      );
    }
  });
  txn();
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

describe("telemetry queries (component 27)", () => {
  it("summary and agents summarize actual stored telemetry", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-queries-"),
      telemetryBatchFlushMs: 25,
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["query-a", "query-b"]);
      await withAuthedClients(app, [a.token, b.token], async ([ca, cb]) => {
        const t1 = (await ca.callTool({
          name: "create_task",
          arguments: { title: "a-1" },
        })) as { structuredContent: Record<string, unknown> };
        await ca.callTool({
          name: "create_task",
          arguments: { title: "a-2" },
        });
        await cb.callTool({
          name: "create_task",
          arguments: { title: "b-1" },
        });
        const taskId = t1.structuredContent["task_id"] as string;
        await ca.callTool({
          name: "post_comment",
          arguments: { task_id: taskId, content: "first" },
        });
        await ca.callTool({
          name: "post_comment",
          arguments: { task_id: taskId, content: "second" },
        });
        await cb.callTool({
          name: "post_comment",
          arguments: { task_id: taskId, content: "third" },
        });
      });
      // Real OTLP intake behind the totals.
      const res = await fetch(`${app.url}/otel/v1/traces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "1".repeat(32),
                      spanId: "2".repeat(16),
                      name: "inference",
                      attributes: [
                        {
                          key: "gen_ai.usage.input_tokens",
                          value: { intValue: "100" },
                        },
                        {
                          key: "gen_ai.usage.output_tokens",
                          value: { intValue: "50" },
                        },
                        {
                          key: "gen_ai.usage.cost_micro_usd",
                          value: { intValue: "2500" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      await waitFor(async () => {
        const s = (await (
          await get(app.url, "/api/telemetry/summary", adminCookie(app.db!))
        ).json()) as Record<string, number>;
        return s["total_tokens_used"] === 150;
      });

      const cookie = adminCookie(app.db!);
      expect(
        await (await get(app.url, "/api/telemetry/summary", cookie)).json(),
      ).toEqual({
        total_comments: 3,
        total_tasks: 3,
        active_agents: 2,
        total_tokens_used: 150,
        total_cost_micro_usd: 2500,
      });
      const agents = (await (
        await get(app.url, "/api/telemetry/agents", cookie)
      ).json()) as {
        agents: Array<Record<string, unknown>>;
      };
      expect(agents.agents).toEqual([
        {
          agent_id: a.agentId,
          name: "query-a",
          comments_sent: 2,
          tasks_created: 2,
          tokens_used: 150,
          cost_micro_usd: 2500,
        },
        {
          agent_id: b.agentId,
          name: "query-b",
          comments_sent: 1,
          tasks_created: 1,
          tokens_used: 0,
          cost_micro_usd: 0,
        },
      ]);

      // Disabled agents leave the per-agent list but not the active count.
      app
        .db!.prepare("UPDATE agents SET status = 'disabled' WHERE agent_id = ?")
        .run(b.agentId);
      expect(
        (
          (await (
            await get(app.url, "/api/telemetry/summary", cookie)
          ).json()) as Record<string, number>
        )["active_agents"],
      ).toBe(1);

      // Auth and method contracts.
      expect((await get(app.url, "/api/telemetry/summary")).status).toBe(401);
      expect(
        (
          await fetch(`${app.url}/api/telemetry/summary`, {
            method: "POST",
            headers: { cookie: `__Host-polymer_admin=${cookie}` },
          })
        ).status,
      ).toBe(405);
      expect((await get(app.url, "/api/telemetry/nope", cookie)).status).toBe(
        404,
      );
    } finally {
      await app.close();
    }
  }, 60000);

  it("timeline filters by range and agent and paginates opaquely", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-queries-"),
      telemetryBatchFlushMs: 25,
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["query-a", "query-b"]);
      const taskId = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "traced" },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
      seedUsage(app.db!, [
        {
          agentId: a.agentId,
          taskId,
          traceId: "1".repeat(32),
          model: "m",
          provider: "p",
          input: 10,
          output: 5,
          cost: 100,
          recordedAt: "2026-01-05T10:05:00.000Z",
        },
        {
          agentId: a.agentId,
          input: 1,
          output: 1,
          recordedAt: "2026-01-05T10:35:00.000Z",
        },
        {
          agentId: b.agentId,
          input: 2,
          output: 2,
          cost: 50,
          recordedAt: "2026-01-06T00:00:00.000Z",
        },
      ]);
      // One live row proves the default 24h window reads stored telemetry.
      const res = await fetch(`${app.url}/otel/v1/traces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${a.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId: "3".repeat(32),
                      spanId: "4".repeat(16),
                      name: "live",
                      attributes: [
                        {
                          key: "gen_ai.usage.input_tokens",
                          value: { intValue: "7" },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      await waitFor(async () => {
        const t = (await (
          await get(app.url, "/api/telemetry/timeline", adminCookie(app.db!))
        ).json()) as { events: unknown[] };
        return t.events.length === 1;
      });

      const cookie = adminCookie(app.db!);
      const timeline = (
        path: string,
      ): Promise<{
        events: Array<Record<string, unknown>>;
        next_cursor: string | null;
      }> =>
        get(app.url, path, cookie).then(
          (r) =>
            r.json() as Promise<{
              events: Array<Record<string, unknown>>;
              next_cursor: string | null;
            }>,
        );

      const full = await timeline(
        "/api/telemetry/timeline?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z",
      );
      expect(full.next_cursor).toBeNull();
      // The default 24h window sees only the live row, not January.
      const recent = await timeline("/api/telemetry/timeline");
      expect(recent.events).toHaveLength(1);
      expect(recent.events[0]["input_tokens"]).toBe(7);
      expect(recent.next_cursor).toBeNull();
      expect(full.events.map((e) => e["recorded_at"])).toEqual([
        "2026-01-05T10:05:00.000Z",
        "2026-01-05T10:35:00.000Z",
        "2026-01-06T00:00:00.000Z",
      ]);
      expect(full.events[0]).toMatchObject({
        agent_id: a.agentId,
        task_id: taskId,
        trace_id: "1".repeat(32),
        model: "m",
        provider: "p",
        input_tokens: 10,
        output_tokens: 5,
        reported_cost_micro_usd: 100,
        cost_source: "reported",
      });

      // from inclusive, to exclusive.
      const edges = await timeline(
        "/api/telemetry/timeline?from=2026-01-05T10:05:00.000Z&to=2026-01-06T00:00:00.000Z",
      );
      expect(edges.events.map((e) => e["recorded_at"])).toEqual([
        "2026-01-05T10:05:00.000Z",
        "2026-01-05T10:35:00.000Z",
      ]);

      // Agent filter; unknown agents read empty, never 404.
      const filtered = await timeline(
        `/api/telemetry/timeline?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z&agent_id=${b.agentId}`,
      );
      expect(filtered.events).toHaveLength(1);
      expect(filtered.events[0]["agent_id"]).toBe(b.agentId);
      expect(
        (
          await timeline(
            "/api/telemetry/timeline?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z&agent_id=nope",
          )
        ).events,
      ).toEqual([]);

      // Opaque pagination walks the whole ordered set exactly once.
      const page1 = await timeline(
        "/api/telemetry/timeline?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z&limit=2",
      );
      expect(page1.events).toHaveLength(2);
      expect(typeof page1.next_cursor).toBe("string");
      expect(page1.next_cursor).not.toContain("2026");
      const page2 = await timeline(
        `/api/telemetry/timeline?from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z&limit=2&cursor=${encodeURIComponent(page1.next_cursor!)}`,
      );
      expect(page2.events).toHaveLength(1);
      expect(page2.next_cursor).toBeNull();
      expect([...page1.events, ...page2.events]).toEqual(full.events);

      // Bad ranges and cursors are 400, never 500.
      for (const bad of [
        "/api/telemetry/timeline?from=nope",
        "/api/telemetry/timeline?from=2026-01-06T00:00:00.000Z&to=2026-01-05T00:00:00.000Z",
        "/api/telemetry/timeline?from=2026-01-01T00:00:00.000Z&to=2026-02-05T00:00:00.000Z",
        "/api/telemetry/timeline?limit=0",
        "/api/telemetry/timeline?limit=501",
        "/api/telemetry/timeline?cursor=tampered",
      ]) {
        expect(await (await get(app.url, bad, cookie)).json()).toEqual({
          error: expect.any(String),
        });
        expect((await get(app.url, bad, cookie)).status).toBe(400);
      }
    } finally {
      await app.close();
    }
  }, 60000);

  it("costs bucket UTC-aligned series with zero-filled gaps", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-queries-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["query-a"]);
      seedUsage(app.db!, [
        {
          agentId: a.agentId,
          input: 10,
          output: 5,
          cost: 100,
          recordedAt: "2026-01-05T10:05:00.000Z",
        },
        {
          agentId: a.agentId,
          input: 1,
          output: 1,
          recordedAt: "2026-01-05T10:35:00.000Z",
        },
        {
          agentId: a.agentId,
          input: 2,
          output: 2,
          cost: 50,
          recordedAt: "2026-01-06T00:00:00.000Z",
        },
      ]);
      const cookie = adminCookie(app.db!);
      const costs = (path: string): Promise<Response> =>
        get(app.url, path, cookie);

      expect(
        await (
          await costs(
            "/api/telemetry/costs?granularity=hourly&from=2026-01-05T10:00:00.000Z&to=2026-01-05T13:00:00.000Z",
          )
        ).json(),
      ).toEqual({
        time_series: [
          { bucket_start: "2026-01-05T10:00:00.000Z", cost_micro_usd: 100 },
          { bucket_start: "2026-01-05T11:00:00.000Z", cost_micro_usd: 0 },
          { bucket_start: "2026-01-05T12:00:00.000Z", cost_micro_usd: 0 },
        ],
      });
      // Unaligned from still opens on the floored bucket — but the
      // 10:05 row falls outside the range, so the bucket reads 0.
      expect(
        (
          (await (
            await costs(
              "/api/telemetry/costs?granularity=hourly&from=2026-01-05T10:15:00.000Z&to=2026-01-05T12:00:00.000Z",
            )
          ).json()) as { time_series: Array<Record<string, unknown>> }
        ).time_series,
      ).toEqual([
        { bucket_start: "2026-01-05T10:00:00.000Z", cost_micro_usd: 0 },
        { bucket_start: "2026-01-05T11:00:00.000Z", cost_micro_usd: 0 },
      ]);
      expect(
        await (
          await costs(
            "/api/telemetry/costs?granularity=daily&from=2026-01-05T00:00:00.000Z&to=2026-01-07T00:00:00.000Z",
          )
        ).json(),
      ).toEqual({
        time_series: [
          { bucket_start: "2026-01-05T00:00:00.000Z", cost_micro_usd: 100 },
          { bucket_start: "2026-01-06T00:00:00.000Z", cost_micro_usd: 50 },
        ],
      });
      // Default window: last 24h, hourly → always 24 buckets.
      const def = (await (
        await costs("/api/telemetry/costs?granularity=daily")
      ).json()) as { time_series: unknown[] };
      expect(def.time_series.length).toBeGreaterThan(0);
      // Default window: last 24h. Hourly buckets are consecutive UTC
      // hours (24 whole hours plus a possible partial current hour).
      const defHourly = (await (
        await costs("/api/telemetry/costs?granularity=hourly")
      ).json()) as { time_series: Array<{ bucket_start: string }> };
      expect(defHourly.time_series.length).toBeGreaterThanOrEqual(24);
      expect(defHourly.time_series.length).toBeLessThanOrEqual(25);
      for (const b of defHourly.time_series) {
        expect(b.bucket_start).toMatch(/T\d{2}:00:00\.000Z$/);
      }
      for (let i = 1; i < defHourly.time_series.length; i += 1) {
        expect(
          Date.parse(defHourly.time_series[i].bucket_start) -
            Date.parse(defHourly.time_series[i - 1].bucket_start),
        ).toBe(3600_000);
      }

      for (const bad of [
        "/api/telemetry/costs",
        "/api/telemetry/costs?granularity=weekly",
        "/api/telemetry/costs?granularity=hourly&from=2026-01-01T00:00:00.000Z&to=2026-02-05T00:00:00.000Z",
      ]) {
        expect((await costs(bad)).status).toBe(400);
      }
    } finally {
      await app.close();
    }
  });
});
