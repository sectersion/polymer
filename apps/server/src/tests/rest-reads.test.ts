import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  closeDatabase,
  openDatabase,
  type PolymerDatabase,
} from "../database/db.js";
import { mintCredential } from "../identity/credentials.js";
import { listen } from "../http/server.js";
import {
  registerAgentsOn,
  withAuthedClients,
  tempDbPath,
} from "./test-support.js";

interface CallOutcome {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

async function callTool(
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

function adminCookie(app: { db: PolymerDatabase | null }): string {
  // Service-seeded admin session (the design's component-18 seam;
  // login itself is component 19). The mint returns the full
  // "<publicId>.<secret>" token — do NOT re-prefix it.
  const { secret } = mintCredential(app.db!, {
    type: "admin_session",
  });
  return secret;
}

function restGet(
  url: string,
  path: string,
  cookie?: string,
): Promise<Response> {
  return fetch(`${url}${path}`, {
    headers: cookie ? { cookie: `__Host-polymer_admin=${cookie}` } : {},
  });
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

describe("REST reads (component 18)", () => {
  it("a REST client inspects the same fleet state agents create over MCP", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-rest-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let detailViaMcp: Record<string, unknown> = {};
      await withAuthedClients(app, [a.token], async ([client]) => {
        await callTool(client, "create_task", { title: "First" });
        const created = await callTool(client, "create_task", {
          title: "Hot",
        });
        const taskId = created.structuredContent!["task_id"] as string;
        await callTool(client, "claim_task", { task_id: taskId });
        await callTool(client, "post_comment", {
          task_id: taskId,
          content: "@agent-b look at this",
          trace_parent: "00-abc-def-01",
        });
        const detail = await callTool(client, "get_task_detail", {
          task_id: taskId,
        });
        detailViaMcp = detail.structuredContent!;
        expect(detailViaMcp["task_id"]).toBe(taskId);
        return taskId;
      });
      // A task created by B for the created_by filter.
      await withAuthedClients(app, [b.token], async ([client]) => {
        await callTool(client, "create_task", { title: "From B" });
      });

      const cookie = adminCookie(app);

      // Agent reads.
      const agents = await jsonBody(
        await restGet(app.url, "/api/agents", cookie),
      );
      expect(Object.keys(agents).sort()).toEqual(["agents"]);
      expect(
        (agents["agents"] as Array<Record<string, unknown>>).find(
          (x) => x["agent_id"] === b.agentId,
        ),
      ).toBeTruthy();

      const agentDetail = await jsonBody(
        await restGet(app.url, `/api/agents/${b.agentId}`, cookie),
      );
      expect(agentDetail["name"]).toBe("agent-b");

      // Task list: parity of items with the MCP surface (same service
      // serializers) — the claimed task shows its post-claim epoch.
      const list = await jsonBody(await restGet(app.url, "/api/tasks", cookie));
      expect(Object.keys(list).sort()).toEqual(["next_cursor", "tasks"]);
      const items = list["tasks"] as Array<Record<string, unknown>>;
      expect(items).toHaveLength(3);
      const hot = items.find((t) => t["title"] === "Hot")!;
      expect(hot["status"]).toBe("in_progress");
      // A claim of the creator's own live lease is a renew: the
      // ownership epoch is unchanged.
      expect(hot["lease_generation"]).toBe(1);
      expect(Object.keys(hot).sort()).toEqual([
        "assigned_to",
        "coordinator",
        "created_at",
        "created_by",
        "lease_expires_at",
        "lease_generation",
        "status",
        "task_id",
        "title",
        "trace_parent",
        "version",
      ]);

      // Detail parity: REST answers the EXACT same object as MCP.
      const detailResponse = await restGet(
        app.url,
        `/api/tasks/${detailViaMcp["task_id"]}`,
        cookie,
      );
      expect(detailResponse.status).toBe(200);
      const restDetail = await jsonBody(detailResponse);
      expect(restDetail).toEqual(detailViaMcp);

      // Comment page.
      const commentsResponse = await restGet(
        app.url,
        `/api/tasks/${detailViaMcp["task_id"]}/comments`,
        cookie,
      );
      expect(commentsResponse.status).toBe(200);
      const page = await jsonBody(commentsResponse);
      expect(Object.keys(page).sort()).toEqual(["comments", "next_cursor"]);
      const comments = page["comments"] as Array<Record<string, unknown>>;
      expect(comments).toHaveLength(1);
      expect(comments[0]["content"]).toBe("@agent-b look at this");
      expect(page["next_cursor"]).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("task filtering and cursor pagination work exactly as the list conventions demand", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-rest-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let filterTargetId = "";
      await withAuthedClients(app, [a.token], async ([client]) => {
        for (let i = 0; i < 55; i += 1) {
          const created = await callTool(client, "create_task", {
            title: `t-${String(i).padStart(2, "0")}`,
          });
          if (i === 7) {
            filterTargetId = created.structuredContent!["task_id"] as string;
          }
        }
        await callTool(client, "assign_task", {
          task_id: filterTargetId,
          agent_ids: [b.agentId],
          lease_generation: 1,
          expected_version: 1,
        });
      });

      const cookie = adminCookie(app);
      // assigned_to filter resolves by persisted rows.
      const mine = await jsonBody(
        await restGet(app.url, "/api/tasks?assigned_to=" + b.agentId, cookie),
      );
      expect(
        (mine["tasks"] as Array<Record<string, unknown>>).map(
          (t) => t["task_id"],
        ),
      ).toEqual([filterTargetId]);

      // Paging: 55 tasks -> 50 + cursor -> 5 + terminal null.
      const p1 = await jsonBody(
        await restGet(app.url, "/api/tasks?limit=50", cookie),
      );
      expect((p1["tasks"] as unknown[]).length).toBe(50);
      expect(p1["next_cursor"]).toBeTruthy();
      const p2 = await jsonBody(
        await restGet(
          app.url,
          `/api/tasks?limit=50&cursor=${p1["next_cursor"]}`,
          cookie,
        ),
      );
      expect((p2["tasks"] as unknown[]).length).toBe(5);
      expect(p2["next_cursor"]).toBeNull();

      // No interrupted collection in an empty page across the seam.
      const bogus = await restGet(
        app.url,
        "/api/tasks?status=not_a_status",
        cookie,
      );
      expect(bogus.status).toBe(400);
      expect((await jsonBody(bogus))["error"]).toBe("invalid_status");
    } finally {
      await app.close();
    }
  });

  it("reads require a live admin session; agent rows and junk are invalid_token", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-rest-"),
    });
    try {
      const [, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      // An agent_session credential in the admin cookie cannot read
      // REST (only admin_session authenticates these routes).
      expect((await restGet(app.url, "/api/tasks", b.token)).status).toBe(401);

      // An admin session: service seed and read.
      const admin = adminCookie(app);
      expect((await restGet(app.url, "/api/agents", admin)).status).toBe(200);

      // Revoke it -> reads 401 again.
      app
        .db!.prepare(
          "UPDATE credentials SET status = 'revoked' WHERE type = 'admin_session'",
        )
        .run();
      expect((await restGet(app.url, "/api/agents", admin)).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("unknown ids, cursors, limits, and methods answer catalog statuses", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-rest-"),
    });
    try {
      const cookie = adminCookie(app);
      void randomUUID;
      const agent = await restGet(
        app.url,
        `/api/agents/${randomUUID()}`,
        cookie,
      );
      expect(agent.status).toBe(404);
      expect((await jsonBody(agent))["error"]).toBe("agent_not_found");

      const task = await restGet(app.url, `/api/tasks/${randomUUID()}`, cookie);
      expect(task.status).toBe(404);
      expect((await jsonBody(task))["error"]).toBe("task_not_found");

      const cursor = await restGet(
        app.url,
        "/api/tasks?cursor=garbage",
        cookie,
      );
      expect(cursor.status).toBe(400);
      expect((await jsonBody(cursor))["error"]).toBe("invalid_cursor");

      const limit = await restGet(app.url, "/api/tasks?limit=junk", cookie);
      expect(limit.status).toBe(400);
      expect((await jsonBody(limit))["error"]).toBe("invalid_request");

      const commentsLimit = await restGet(
        app.url,
        "/api/tasks/x/comments?limit=0",
        cookie,
      );
      expect(commentsLimit.status).toBe(400);

      const method = await fetch(`${app.url}/api/tasks`, { method: "POST" });
      expect(method.status).toBe(405);
      expect((await jsonBody(method))["error"]).toBe("method_not_allowed");

      // GET /api/audit is a component-19 route (audits begin empty).
      const unknownApi = await restGet(app.url, "/api/audit", cookie);
      expect(unknownApi.status).toBe(200);
      expect(Object.keys(await jsonBody(unknownApi)).sort()).toEqual([
        "audits",
        "next_cursor",
      ]);
    } finally {
      await app.close();
    }
  });

  it("driver failures surface as 503 database_error without SQL leakage", async () => {
    const dbPath = tempDbPath("polymer-rest-");
    const broken = openDatabase(dbPath);
    broken.prepare("DROP TABLE comments").run();
    broken.prepare("DROP TABLE tasks").run();
    closeDatabase(broken);

    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const cookie = adminCookie(app);
      const res = await restGet(app.url, "/api/tasks", cookie);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain("database_error");
      expect(text).not.toMatch(/SQLITE|no such table/i);
    } finally {
      await app.close();
    }
  });
});
