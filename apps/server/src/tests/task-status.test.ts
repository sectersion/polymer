import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { listen } from "../http/server.js";
import { getTask } from "../tasks/index.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
  type AgentSession,
  type App,
} from "./test-support.js";

interface CallOutcome {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callTask(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallOutcome> {
  const result = (await client.callTool({
    name,
    arguments: args,
  })) as unknown as CallOutcome;
  return result;
}

/** A creates a task and starts it over real MCP: in_progress at
 * version 2, generation 1, live renewed lease. */
async function inProgressTask(
  app: App,
  a: AgentSession,
  title: string,
): Promise<{ taskId: string; version: number; leaseGeneration: number }> {
  return withAuthedClients(app, [a.token], async ([client]) => {
    const created = await callTask(client, "create_task", { title });
    expect(created.isError).toBeFalsy();
    const taskId = created.structuredContent!["task_id"] as string;
    const claimed = await callTask(client, "claim_task", { task_id: taskId });
    expect(claimed.isError, JSON.stringify(claimed)).toBeFalsy();
    return {
      taskId,
      version: claimed.structuredContent!["version"] as number,
      leaseGeneration: claimed.structuredContent!["lease_generation"] as number,
    };
  });
}

describe("update_task_status (component 16)", () => {
  it("concurrent updates race the fence: one lands, stale state is rejected, and done is terminal", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-task-status-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const { taskId, version, leaseGeneration } = await inProgressTask(
        app,
        a,
        "Race to done",
      );
      expect(version).toBe(2);
      expect(leaseGeneration).toBe(1);

      // Two identical concurrent writes: the fence lets exactly one
      // through. Same engine, same firewall.
      await withAuthedClients(app, [a.token], async ([client]) => {
        const args = {
          task_id: taskId,
          status: "done",
          lease_generation: 1,
          expected_version: 2,
        };
        const [first, second] = await Promise.all([
          callTask(client, "update_task_status", args),
          callTask(client, "update_task_status", args),
        ]);
        const winners = [first, second].filter((o) => !o.isError);
        expect(winners).toHaveLength(1);
        // The winner's write to done cleared the lease inside the same
        // transaction, so the loser faces an empty lease: unauthorized
        // (never fully applied) — the fence holds either way.
        const loser = [first, second].find((o) => o.isError)!;
        expect(JSON.stringify(loser)).toContain("unauthorized");

        const out = winners[0].structuredContent!;
        expect(Object.keys(out).sort()).toEqual([
          "status",
          "task_id",
          "updated_at",
          "version",
        ]);
        expect(out["status"]).toBe("done");
        expect(out["version"]).toBe(3);
      });

      // Entering done cleared the lease (generation unchanged).
      const stored = getTask(app.db!, taskId)!;
      expect(stored.status).toBe("done");
      expect(stored.version).toBe(3);
      expect(stored.lease_generation).toBe(1);
      expect(stored.lease_expires_at).toBeNull();

      // The coordinator has no live lease anymore: a further update is
      // unauthorized, even with the freshest fence values.
      await withAuthedClients(app, [a.token], async ([client]) => {
        const later = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "done",
          lease_generation: 1,
          expected_version: 3,
        });
        expect(later.isError).toBe(true);
        expect(JSON.stringify(later)).toContain("unauthorized");

        // claim_task cannot resurrect done — the terminal status is
        // invalid_status on the claim surface.
        const claim = await callTask(client, "claim_task", {
          task_id: taskId,
        });
        expect(claim.isError).toBe(true);
        expect(JSON.stringify(claim)).toContain("invalid_status");

        // B (any authenticated agent) gets the same terminality.
        return;
      });
      await withAuthedClients(app, [b.token], async ([client]) => {
        const claim = await callTask(client, "claim_task", {
          task_id: taskId,
        });
        expect(claim.isError).toBe(true);
        expect(JSON.stringify(claim)).toContain("invalid_status");
      });
      expect(getTask(app.db!, taskId)!.status).toBe("done");
    } finally {
      await app.close();
    }
  });

  it("transitions outside the table are invalid_status and mutate nothing", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-task-status-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const { taskId, version } = await inProgressTask(app, a, "Locked tiger");

      await withAuthedClients(app, [a.token], async ([client]) => {
        // Same-state writes are not in the table.
        const sameState = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "in_progress",
          lease_generation: 1,
          expected_version: version,
        });
        expect(sameState.isError).toBe(true);
        expect(JSON.stringify(sameState)).toContain("invalid_status");

        // to_do is exited only through claim_task.
        const back = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "to_do",
          lease_generation: 1,
          expected_version: version,
        });
        expect(back.isError).toBe(true);
        expect(JSON.stringify(back)).toContain("invalid_status");
      });

      const stored = getTask(app.db!, taskId)!;
      expect(stored.status).toBe("in_progress");
      expect(stored.version).toBe(version);
    } finally {
      await app.close();
    }
  });

  it("a stale expected_version fails without mutation; the fresh write lands", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-task-status-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const { taskId, version } = await inProgressTask(app, a, "Versioned");

      await withAuthedClients(app, [a.token], async ([client]) => {
        const stale = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "done",
          lease_generation: 1,
          expected_version: version - 1,
        });
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale)).toContain("version_mismatch");
        expect(getTask(app.db!, taskId)!.version).toBe(version);

        const fresh = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "failed",
          lease_generation: 1,
          expected_version: version,
        });
        expect(fresh.isError, JSON.stringify(fresh)).toBeFalsy();
        expect(fresh.structuredContent!["status"]).toBe("failed");
        expect(fresh.structuredContent!["version"]).toBe(version + 1);
      });

      const stored = getTask(app.db!, taskId)!;
      expect(stored.status).toBe("failed");
      expect(stored.lease_expires_at).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("a stale lease_generation is rejected through every mutation surface", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-task-status-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const { taskId, version } = await inProgressTask(app, a, "Fenced");

      await withAuthedClients(app, [a.token], async ([client]) => {
        const stale = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "done",
          lease_generation: 5,
          expected_version: version,
        });
        expect(stale.isError).toBe(true);
        expect(JSON.stringify(stale)).toContain("version_mismatch");
      });
      expect(getTask(app.db!, taskId)!.version).toBe(version);
    } finally {
      await app.close();
    }
  });

  it("failed -> to_do needs a live lease the entering-failed write just cleared", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-task-status-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      const { taskId, version } = await inProgressTask(app, a, "Retry me");

      await withAuthedClients(app, [a.token], async ([client]) => {
        const failed = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "failed",
          lease_generation: 1,
          expected_version: version,
        });
        expect(failed.isError, JSON.stringify(failed)).toBeFalsy();

        // Even the coordinator cannot requeue: entering failed cleared
        // the lease, and this transition requires it live. Recovery is
        // reclaim via claim_task; admin force is REST-only.
        const requeue = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "to_do",
          lease_generation: 1,
          expected_version: version + 1,
        });
        expect(requeue.isError).toBe(true);
        expect(JSON.stringify(requeue)).toContain("unauthorized");
      });
      expect(getTask(app.db!, taskId)!.status).toBe("failed");
    } finally {
      await app.close();
    }
  });

  it("only the coordinator mutates status; a caller-supplied status outside the enum is a schema violation", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-task-status-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const { taskId, version } = await inProgressTask(app, a, "Owned");

      await withAuthedClients(app, [b.token], async ([client]) => {
        const rejected = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "done",
          lease_generation: 1,
          expected_version: version,
        });
        expect(rejected.isError).toBe(true);
        expect(JSON.stringify(rejected)).toContain("unauthorized");

        const malformed = await callTask(client, "update_task_status", {
          task_id: taskId,
          status: "COMPLETE",
          lease_generation: 1,
          expected_version: version,
        });
        expect(malformed.isError).toBe(true);
        expect(JSON.stringify(malformed)).toContain("-32602");

        const unknownTask = await callTask(client, "update_task_status", {
          task_id: randomUUID(),
          status: "done",
          lease_generation: 1,
          expected_version: 1,
        });
        expect(unknownTask.isError).toBe(true);
        expect(JSON.stringify(unknownTask)).toContain("task_not_found");
      });
      expect(getTask(app.db!, taskId)!.version).toBe(version);
    } finally {
      await app.close();
    }
  });
});
