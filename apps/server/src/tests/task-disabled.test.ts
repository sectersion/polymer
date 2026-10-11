import { describe, expect, it } from "vitest";
import { getAgentById } from "../identity/agents.js";
import { listen } from "../http/server.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

describe("disabled agents cannot mutate (loose-end A)", () => {
  it("every task/comment mutation rejects with unauthorized; reads stay open", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-disabled-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["doomed", "steady"]);
      const taskId = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "work" },
        })) as { structuredContent: Record<string, unknown> };
        return t.structuredContent["task_id"] as string;
      });
      app
        .db!.prepare("UPDATE agents SET status = 'disabled' WHERE agent_id = ?")
        .run(a.agentId);
      expect(getAgentById(app.db!, a.agentId)?.status).toBe("disabled");

      const failures: Array<{ tool: string; body: unknown }> = [];
      await withAuthedClients(app, [a.token], async ([ca]) => {
        const attempt = async (tool: string, args: Record<string, unknown>) => {
          const out = (await ca.callTool({
            name: tool,
            arguments: args,
          })) as unknown as {
            isError?: boolean;
          };
          expect(out.isError, tool).toBe(true);
          expect(JSON.stringify(out), tool).toContain("unauthorized");
          failures.push({ tool, body: out });
        };
        await attempt("create_task", { title: "nope" });
        await attempt("claim_task", { task_id: taskId });
        await attempt("post_comment", { task_id: taskId, content: "nope" });
        await attempt("mark_ping_read", { mention_id: "nope" });
        // Reads stay open: a disabled agent can still inspect.
        const pings = (await ca.callTool({
          name: "get_unread_pings",
          arguments: {},
        })) as { structuredContent: Record<string, unknown> };
        expect(pings.structuredContent["pings"]).toEqual([]);
        const detail = (await ca.callTool({
          name: "get_task_detail",
          arguments: { task_id: taskId },
        })) as { structuredContent: Record<string, unknown> };
        expect(detail.structuredContent["task_id"]).toBe(taskId);
        const tasks = (await ca.callTool({
          name: "get_tasks",
          arguments: {},
        })) as { structuredContent: Record<string, unknown> };
        expect(
          (tasks.structuredContent["tasks"] as unknown[]).length,
        ).toBeGreaterThan(0);
      });
      expect(failures.map((f) => f.tool).sort()).toEqual(
        ["claim_task", "create_task", "mark_ping_read", "post_comment"].sort(),
      );

      // The enabled agent is unaffected on the same task.
      await withAuthedClients(app, [b.token], async ([cb]) => {
        const comment = (await cb.callTool({
          name: "post_comment",
          arguments: { task_id: taskId, content: "still works" },
        })) as { structuredContent: Record<string, unknown> };
        expect(comment.structuredContent["comment_id"]).toBeDefined();
      });
    } finally {
      await app.close();
    }
  });

  it("coordinator-gated writes reject disabled coordinators too", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-disabled-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["coord", "other"]);
      const ids = await withAuthedClients(app, [a.token], async ([ca]) => {
        const t = (await ca.callTool({
          name: "create_task",
          arguments: { title: "owned" },
        })) as { structuredContent: Record<string, unknown> };
        const taskId = t.structuredContent["task_id"] as string;
        await ca.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        });
        const detail = (await ca.callTool({
          name: "get_task_detail",
          arguments: { task_id: taskId },
        })) as { structuredContent: Record<string, unknown> };
        return {
          taskId,
          generation: detail.structuredContent["lease_generation"] as number,
          version: detail.structuredContent["version"] as number,
        };
      });
      app
        .db!.prepare("UPDATE agents SET status = 'disabled' WHERE agent_id = ?")
        .run(a.agentId);
      await withAuthedClients(app, [a.token], async ([ca]) => {
        for (const [tool, args] of [
          [
            "assign_task",
            {
              task_id: ids.taskId,
              agent_ids: [b.agentId],
              lease_generation: ids.generation,
              expected_version: ids.version,
            },
          ],
          [
            "transfer_coordinator",
            {
              task_id: ids.taskId,
              new_coordinator_id: b.agentId,
              lease_generation: ids.generation,
              expected_version: ids.version,
            },
          ],
          ["request_unassignment", { task_id: ids.taskId }],
          [
            "update_task_status",
            {
              task_id: ids.taskId,
              status: "done",
              lease_generation: ids.generation,
              expected_version: ids.version,
            },
          ],
        ] as Array<[string, Record<string, unknown>]>) {
          const out = (await ca.callTool({
            name: tool,
            arguments: args,
          })) as unknown as {
            isError?: boolean;
          };
          expect(out.isError, tool).toBe(true);
          expect(JSON.stringify(out), tool).toContain("unauthorized");
        }
      });
    } finally {
      await app.close();
    }
  });
});
