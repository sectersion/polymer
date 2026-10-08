import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { mintCredential } from "./credentials.js";
import { registerAgent } from "./registration.js";
import { createTask, getTask } from "./tasks.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-claim-tasks-")), "test.db");
}

type App = Awaited<ReturnType<typeof listen>>;

interface AgentSession {
  agentId: string;
  token: string;
}

/** Register a handful of agents over real MCP (bootstrap surface). */
async function registerAgentsOn(
  app: App,
  names: string[],
): Promise<AgentSession[]> {
  const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
  await bootstrap.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  try {
    const sessions: AgentSession[] = [];
    for (const name of names) {
      const { credential, secret } = mintCredential(app.db!, {
        type: "init",
      });
      const reg = (await bootstrap.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: credential.credential_id,
          init_token: secret,
          name,
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      sessions.push({
        agentId: reg.structuredContent["agent_id"] as string,
        token: reg.structuredContent["session_token"] as string,
      });
    }
    return sessions;
  } finally {
    await bootstrap.close();
  }
}

/**
 * Seed the 100-claimant fleet through the registration service the
 * MCP tool wraps: init-token registration over real MCP is proven in
 * component 7, but its 10/min-per-IP + 60/min global OTP budget
 * cannot mint ~100 agents inside one test window.
 */
function seedAgents(app: App, names: string[]): AgentSession[] {
  return names.map((name) => {
    const { credential, secret } = mintCredential(app.db!, {
      type: "init",
    });
    const out = registerAgent(app.db!, {
      initTokenId: credential.credential_id,
      initToken: secret,
      name,
      role: "coder",
    });
    return { agentId: out.agent_id, token: out.session_token };
  });
}

/** Attach real MCP clients (own sessions) to an already-listening app. */
async function withAuthedClients<T>(
  app: App,
  tokens: string[],
  fn: (clients: Client[]) => Promise<T>,
): Promise<T> {
  const clients: Client[] = [];
  for (const token of tokens) {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
  }
  try {
    return await fn(clients);
  } finally {
    for (const client of clients) {
      await client.close();
    }
  }
}

interface CallOutcome {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callClaim(
  client: Client,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const result = (await client.callTool({
    name: "claim_task",
    arguments: args,
  })) as unknown as CallOutcome;
  return result;
}

/** Lapse the lazy-expiry lease: the task becomes claimable. */
function lapseLeases(app: App): void {
  app
    .db!.prepare(
      "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z'",
    )
    .run();
}

describe("claim_task MCP tool (component 13)", () => {
  it("two agents race for one task: exactly one success, the loser gets task_already_claimed", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let taskId = "";
      await withAuthedClients(app, [a.token], async ([creator]) => {
        const created = (await creator.callTool({
          name: "create_task",
          arguments: { title: "Contested" },
        })) as { structuredContent: Record<string, unknown> };
        taskId = created.structuredContent["task_id"] as string;
      });
      lapseLeases(app);

      await withAuthedClients(app, [a.token, b.token], async (clients) => {
        const outcomes = await Promise.all(
          clients.map((client) => callClaim(client, { task_id: taskId })),
        );
        const winners = outcomes.filter((o) => !o.isError);
        expect(winners).toHaveLength(1);

        const winner = winners[0].structuredContent!;
        expect(winner["status"]).toBe("in_progress");
        expect([a.agentId, b.agentId]).toContain(winner["coordinator"]);
        expect(winner["lease_generation"]).toBe(2);
        expect(winner["version"]).toBe(2);

        // The loser saw the winner's live lease.
        const loser = outcomes.find((o) => o.isError)!;
        expect(JSON.stringify(loser)).toContain("task_already_claimed");

        // Exactly one owner in the database.
        const stored = getTask(app.db!, taskId)!;
        expect(stored.coordinator).toBe(winner["coordinator"]);
        expect(stored.status).toBe("in_progress");
        expect(stored.version).toBe(2);
        expect(stored.lease_generation).toBe(2);
      });
    } finally {
      await app.close();
    }
  });

  it(
    "100 concurrent claim attempts on one task produce exactly one successful owner",
    { timeout: 60_000 },
    async () => {
      // One server, one SQLite file, 100 real agents. The MCP rate
      // limit default (100/min per agent and per IP for handshakes) is
      // raised for this fixture only: 101 session handshakes exceed it.
      const app = await listen("127.0.0.1", 0, {
        databasePath: tempDbPath(),
        mcpRateLimitPerMin: 1000,
      });
      try {
        const claimants = seedAgents(
          app,
          Array.from(
            { length: 100 },
            (_, i) => `claimer-${String(i).padStart(3, "0")}`,
          ),
        );
        const creator = seedAgents(app, ["creator"])[0];
        const task = createTask(app.db!, {
          title: "Hot task",
          createdBy: creator.agentId,
        });
        // The creator's initial lease lapses (lazy expiry); the task is
        // to_do and claimable by any authenticated agent.
        lapseLeases(app);

        await withAuthedClients(
          app,
          claimants.map((c) => c.token),
          async (clients) => {
            const outcomes = await Promise.all(
              clients.map((client) =>
                callClaim(client, { task_id: task.task_id }),
              ),
            );
            const successes = outcomes.filter((o) => !o.isError);
            const already = outcomes.filter(
              (o) =>
                o.isError && JSON.stringify(o).includes("task_already_claimed"),
            );
            expect(successes).toHaveLength(1);
            expect(already).toHaveLength(99);

            const winner = successes[0].structuredContent!;
            // Exact contract shape: seven fields, nothing more.
            expect(Object.keys(winner).sort()).toEqual([
              "coordinator",
              "lease_expires_at",
              "lease_generation",
              "status",
              "task_id",
              "title",
              "version",
            ]);
            expect(winner["status"]).toBe("in_progress");
            expect(winner["task_id"]).toBe(task.task_id);
            expect(
              claimants.some((c) => c.agentId === winner["coordinator"]),
            ).toBe(true);
            expect(winner["lease_generation"]).toBe(2);
            expect(winner["version"]).toBe(2);

            // Stored state agrees with the single owner.
            const stored = getTask(app.db!, task.task_id)!;
            expect(stored.status).toBe("in_progress");
            expect(stored.version).toBe(2);
            expect(stored.lease_generation).toBe(2);
            expect(stored.coordinator).toBe(winner["coordinator"]);
            expect(
              new Date(stored.lease_expires_at!).getTime(),
            ).toBeGreaterThan(Date.now());
          },
        );
      } finally {
        await app.close();
      }
    },
  );

  it("own live lease renews: version bumps, generation unchanged, expiry extended", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const result = (await client.callTool({
            name: "create_task",
            arguments: { title: "Renew" },
          })) as { structuredContent: Record<string, unknown> };
          return result.structuredContent;
        },
      );

      await withAuthedClients(app, [a.token], async ([client]) => {
        const out = await callClaim(client, {
          task_id: created["task_id"] as string,
        });
        expect(out.isError).toBeFalsy();
        const claim = out.structuredContent!;
        expect(claim["status"]).toBe("in_progress");
        expect(claim["coordinator"]).toBe(a.agentId);
        // Renew bumps version only; the ownership epoch stays.
        expect(claim["version"]).toBe(2);
        expect(claim["lease_generation"]).toBe(1);
        expect(
          new Date(claim["lease_expires_at"] as string).getTime(),
        ).toBeGreaterThan(
          new Date(created["lease_expires_at"] as string).getTime(),
        );
      });
    } finally {
      await app.close();
    }
  });

  it("in_progress with an expired lease is reclaimable with a new generation", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const result = (await client.callTool({
            name: "create_task",
            arguments: { title: "Reclaim" },
          })) as { structuredContent: Record<string, unknown> };
          return result.structuredContent;
        },
      );
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        // A starts working (renew: version 2, generation stays 1).
        const first = await callClaim(client, { task_id: taskId });
        expect(first.structuredContent!["status"]).toBe("in_progress");
        expect(first.structuredContent!["lease_generation"]).toBe(1);
      });

      // A's lease then lapses; the task stays in_progress and becomes
      // claimable (MVP expiry rules) — B reclaims it.
      lapseLeases(app);
      await withAuthedClients(app, [b.token], async ([client]) => {
        const reclaimed = await callClaim(client, { task_id: taskId });
        expect(reclaimed.isError).toBeFalsy();
        const claim = reclaimed.structuredContent!;
        expect(claim["status"]).toBe("in_progress");
        expect(claim["coordinator"]).toBe(b.agentId);
        expect(claim["lease_generation"]).toBe(2);
        expect(claim["version"]).toBe(3);
      });
    } finally {
      await app.close();
    }
  });

  it("failed with an expired lease recovers into in_progress with a new generation", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const task = createTask(app.db!, {
        title: "Failed once",
        createdBy: a.agentId,
      });
      // Spec-reachable seed: entering failed cleared the lease and
      // bumped version (component 17's update path produces this).
      app
        .db!.prepare(
          `UPDATE tasks SET status = 'failed', lease_expires_at = NULL,
              version = 2, updated_at = ? WHERE task_id = ?`,
        )
        .run(new Date().toISOString(), task.task_id);

      await withAuthedClients(app, [b.token], async ([client]) => {
        const out = await callClaim(client, { task_id: task.task_id });
        expect(out.isError).toBeFalsy();
        const claim = out.structuredContent!;
        expect(claim["status"]).toBe("in_progress");
        expect(claim["coordinator"]).toBe(b.agentId);
        expect(claim["lease_generation"]).toBe(2);
        expect(claim["version"]).toBe(3);
      });
    } finally {
      await app.close();
    }
  });

  it("failed with a live lease held by another agent is task_already_claimed", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const task = createTask(app.db!, {
        title: "Failed live",
        createdBy: a.agentId,
      });
      // Defensive matrix edge: failed + live lease (coordinator A).
      app
        .db!.prepare(
          "UPDATE tasks SET status = 'failed', version = 2 WHERE task_id = ?",
        )
        .run(task.task_id);

      await withAuthedClients(app, [b.token], async ([client]) => {
        const out = await callClaim(client, { task_id: task.task_id });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("task_already_claimed");
      });
    } finally {
      await app.close();
    }
  });

  it("done is terminal: claim is invalid_status for coordinator and stranger alike", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const task = createTask(app.db!, {
        title: "Finished",
        createdBy: a.agentId,
      });
      // Spec-reachable seed: entering done cleared the lease and
      // bumped version.
      app
        .db!.prepare(
          `UPDATE tasks SET status = 'done', lease_expires_at = NULL,
              version = 2, updated_at = ? WHERE task_id = ?`,
        )
        .run(new Date().toISOString(), task.task_id);

      await withAuthedClients(app, [a.token, b.token], async (clients) => {
        for (const client of clients) {
          const out = await callClaim(client, {
            task_id: task.task_id,
          });
          expect(out.isError).toBe(true);
          expect(JSON.stringify(out)).toContain("invalid_status");
        }
      });
    } finally {
      await app.close();
    }
  });

  it("a nonexistent task returns task_not_found", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      await withAuthedClients(app, [a.token], async ([client]) => {
        const out = await callClaim(client, { task_id: randomUUID() });
        expect(out.isError).toBe(true);
        expect(JSON.stringify(out)).toContain("task_not_found");
        expect(JSON.stringify(out)).not.toMatch(/SQLITE|no such table/i);
      });
    } finally {
      await app.close();
    }
  });

  it("a non-positive lease duration is schema-rejected as invalid params", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      await withAuthedClients(app, [a.token], async ([client]) => {
        for (const lease_duration_seconds of [0, -5]) {
          const out = await callClaim(client, {
            task_id: randomUUID(),
            lease_duration_seconds,
          });
          expect(out.isError).toBe(true);
          expect(JSON.stringify(out)).toContain("-32602");
        }
      });
    } finally {
      await app.close();
    }
  });

  it("unauthenticated claims are rejected at the HTTP layer", async () => {
    const app = await listen("127.0.0.1", 0, { databasePath: tempDbPath() });
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "claim_task", arguments: { task_id: "x" } },
        }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: "invalid_token",
        reason: "missing",
      });
    } finally {
      await app.close();
    }
  });
});
