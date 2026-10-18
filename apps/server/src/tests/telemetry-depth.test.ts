import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import { mintCredential } from "../identity/credentials.js";
import type { PolymerDatabase } from "../database/db.js";
import { registerAgentsOn, tempDbPath } from "./test-support.js";

function adminCookie(db: PolymerDatabase): string {
  const { secret } = mintCredential(db, { type: "admin_session" });
  return secret;
}

function get(url: string, path: string, cookie?: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    headers: cookie ? { cookie: `__Host-polymer_admin=${cookie}` } : {},
  });
}

function seedUsage(
  db: PolymerDatabase,
  seeds: Array<{
    agentId: string;
    model?: string;
    provider?: string;
    input?: number;
    output?: number;
    cost?: number;
    recordedAt: string;
  }>,
): void {
  const insert = db.prepare(
    `INSERT INTO usage_records
       (usage_id, agent_id, task_id, trace_id, provider, model,
        input_tokens, output_tokens, other_token_categories,
        reported_cost_micro_usd, cost_source, recorded_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  );
  const txn = db.transaction(() => {
    for (const s of seeds) {
      insert.run(
        randomUUID(),
        s.agentId,
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

function seedSpan(
  db: PolymerDatabase,
  opts: {
    traceId: string;
    spanId: string;
    name: string;
    startNs: string;
    statusCode?: number;
    statusMessage?: string | null;
    agentId: string;
  },
): void {
  db.prepare(
    `INSERT INTO otel_spans
       (span_id, trace_id, parent_span_id, name, kind,
        start_time_unix_ns, end_time_unix_ns, status_code, status_message,
        attributes, resource_attributes, scope, agent_id, ingested_at)
     VALUES (?, ?, NULL, ?, 1, ?, ?, ?, ?, '[]', '[]',
       '{"name":"t","version":"1"}', ?, '2026-01-05T10:00:00.000Z')`,
  ).run(
    opts.spanId,
    opts.traceId,
    opts.name,
    opts.startNs,
    opts.startNs,
    opts.statusCode ?? 1,
    opts.statusMessage ?? null,
    opts.agentId,
  );
}

describe("telemetry depth: breakdown + trace detail", () => {
  it("breakdown groups by model/provider with unknown folding", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-depth-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["depth-a"]);
      seedUsage(app.db!, [
        {
          agentId: a.agentId,
          model: "m1",
          provider: "p1",
          input: 100,
          output: 50,
          cost: 2500,
          recordedAt: "2026-01-05T10:05:00.000Z",
        },
        {
          agentId: a.agentId,
          model: "m1",
          provider: "p2",
          input: 10,
          output: 5,
          cost: 100,
          recordedAt: "2026-01-05T11:05:00.000Z",
        },
        {
          agentId: a.agentId,
          input: 1,
          output: 1,
          recordedAt: "2026-01-05T12:05:00.000Z",
        },
      ]);
      const cookie = adminCookie(app.db!);
      const range = "from=2026-01-01T00:00:00.000Z&to=2026-01-31T00:00:00.000Z";

      const models = await (
        await get(
          app.url,
          `/api/telemetry/breakdown?dimension=model&${range}`,
          cookie,
        )
      ).json();
      expect(models).toEqual({
        dimension: "model",
        buckets: [
          { key: "m1", tokens_used: 165, cost_micro_usd: 2600, spans: 2 },
          { key: "unknown", tokens_used: 2, cost_micro_usd: 0, spans: 1 },
        ],
      });

      const providers = await (
        await get(
          app.url,
          `/api/telemetry/breakdown?dimension=provider&${range}`,
          cookie,
        )
      ).json();
      expect(providers).toEqual({
        dimension: "provider",
        buckets: [
          { key: "p1", tokens_used: 150, cost_micro_usd: 2500, spans: 1 },
          { key: "p2", tokens_used: 15, cost_micro_usd: 100, spans: 1 },
          { key: "unknown", tokens_used: 2, cost_micro_usd: 0, spans: 1 },
        ],
      });

      // Contract: auth, method, dimension validation.
      expect(
        (
          await get(
            app.url,
            `/api/telemetry/breakdown?dimension=model&${range}`,
          )
        ).status,
      ).toBe(401);
      for (const bad of [
        "/api/telemetry/breakdown",
        "/api/telemetry/breakdown?dimension=weekly",
        `/api/telemetry/breakdown?dimension=model&from=2026-01-01T00:00:00.000Z&to=2026-02-05T00:00:00.000Z`,
      ]) {
        expect((await get(app.url, bad, cookie)).status).toBe(400);
      }
    } finally {
      await app.close();
    }
  }, 60000);

  it("trace detail returns spans oldest-first with error flags", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-depth-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["depth-a"]);
      const traceId = "a".repeat(32);
      // Inserted out of order: readback must be by start time.
      seedSpan(app.db!, {
        traceId,
        spanId: "b".repeat(16),
        name: "child",
        startNs: "2000",
        statusCode: 2,
        statusMessage: "boom",
        agentId: a.agentId,
      });
      seedSpan(app.db!, {
        traceId,
        spanId: "c".repeat(16),
        name: "root",
        startNs: "1000",
        agentId: a.agentId,
      });
      const cookie = adminCookie(app.db!);

      const res = await get(
        app.url,
        `/api/telemetry/traces/${traceId}`,
        cookie,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        trace_id: traceId,
        spans: [
          {
            span_id: "c".repeat(16),
            parent_span_id: null,
            name: "root",
            start_time_unix_ns: "1000",
            end_time_unix_ns: "1000",
            error: false,
            status_message: null,
            agent_id: a.agentId,
          },
          {
            span_id: "b".repeat(16),
            parent_span_id: null,
            name: "child",
            start_time_unix_ns: "2000",
            end_time_unix_ns: "2000",
            error: true,
            status_message: "boom",
            agent_id: a.agentId,
          },
        ],
      });

      expect(
        (await get(app.url, `/api/telemetry/traces/${"z".repeat(32)}`, cookie))
          .status,
      ).toBe(400);
      expect(
        (await get(app.url, `/api/telemetry/traces/${"d".repeat(32)}`, cookie))
          .status,
      ).toBe(404);
      expect(
        (await get(app.url, `/api/telemetry/traces/${traceId}`)).status,
      ).toBe(401);
    } finally {
      await app.close();
    }
  }, 60000);
});
