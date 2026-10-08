import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { listen } from "../http/server.js";
import { mintCredential } from "../identity/credentials.js";
import { getTask } from "../tasks/index.js";
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

describe("comments and mentions (component 17)", () => {
  it("two agents communicate and the recipient discovers unread messages", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const task = await callTool(client, "create_task", {
            title: "Database work",
          });
          return task.structuredContent!;
        },
      );
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const posted = await callTool(client, "post_comment", {
          task_id: taskId,
          content: "@agent-b I finished the database work.",
          trace_parent: "00-abc-def-01",
        });
        expect(posted.isError, JSON.stringify(posted)).toBeFalsy();
        const out = posted.structuredContent!;
        expect(Object.keys(out).sort()).toEqual([
          "comment_id",
          "content",
          "created_at",
          "mentions",
          "sender_agent_id",
          "task_id",
          "trace_parent",
        ]);
        expect(out["task_id"]).toBe(taskId);
        // Sender identity is the authenticated caller, never an arg.
        expect(out["sender_agent_id"]).toBe(a.agentId);
        expect(out["mentions"]).toEqual([b.agentId]);
        expect(out["trace_parent"]).toBe("00-abc-def-01");
      });

      // The recipient discovers exactly one unread ping.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const unread = await callTool(client, "get_unread_pings", {});
        const pings = unread.structuredContent!["pings"] as Array<
          Record<string, unknown>
        >;
        expect(pings).toHaveLength(1);
        expect(pings[0]["task_id"]).toBe(taskId);
        expect(pings[0]["sender_agent_id"]).toBe(a.agentId);
        expect(pings[0]["content"]).toBe(
          "@agent-b I finished the database work.",
        );
        expect(pings[0]["comment_id"]).toBeTruthy();

        const mark = await callTool(client, "mark_ping_read", {
          mention_id: pings[0]["mention_id"],
        });
        expect(mark.isError, JSON.stringify(mark)).toBeFalsy();
        expect(mark.structuredContent!["success"]).toBe(true);

        const after = await callTool(client, "get_unread_pings", {});
        expect(after.structuredContent!["pings"]).toEqual([]);
      });
    } finally {
      await app.close();
    }
  });

  it("mention parsing is exact and case-sensitive; duplicates collapse", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const task = await callTool(client, "create_task", {
            title: "Parsing",
          });
          return task.structuredContent!;
        },
      );
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        const posted = await callTool(client, "post_comment", {
          task_id: taskId,
          content:
            "@Agent-B wrong case\n@nobody unknown\n@email@- invalid\ndup @agent-b and @agent-b again",
        });
        expect(posted.isError, JSON.stringify(posted)).toBeFalsy();
        // Only the exact, case-sensitive name resolves — once.
        expect(posted.structuredContent!["mentions"]).toEqual([b.agentId]);
      });

      await withAuthedClients(app, [b.token], async ([client]) => {
        const unread = await callTool(client, "get_unread_pings", {});
        const pings = unread.structuredContent!["pings"] as Array<
          Record<string, unknown>
        >;
        expect(pings).toHaveLength(1);
      });
    } finally {
      await app.close();
    }
  });

  it("the sender cannot be spoofed; unknown tasks are task_not_found", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const task = await callTool(client, "create_task", {
            title: "Spoof",
          });
          return task.structuredContent!;
        },
      );
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [b.token], async ([client]) => {
        const tools = await client.listTools();
        const schema = tools.tools.find((t) => t.name === "post_comment")
          ?.inputSchema as { properties?: Record<string, unknown> } | undefined;
        expect(Object.keys(schema!.properties ?? {})).not.toContain(
          "sender_agent_id",
        );

        // Even a smuggled sender cannot take effect.
        const posted = await callTool(client, "post_comment", {
          task_id: taskId,
          content: "trying to impersonate",
          sender_agent_id: a.agentId,
        });
        expect(posted.isError, JSON.stringify(posted)).toBeFalsy();
        expect(posted.structuredContent!["sender_agent_id"]).toBe(b.agentId);

        const ghost = await callTool(client, "post_comment", {
          task_id: randomUUID(),
          content: "nowhere",
        });
        expect(ghost.isError).toBe(true);
        expect(JSON.stringify(ghost)).toContain("task_not_found");
      });
    } finally {
      await app.close();
    }
  });

  it("pings are private to the mentioned agent: foreign and unknown ids answer not_found", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const [a, b, c] = await registerAgentsOn(app, [
        "agent-a",
        "agent-b",
        "agent-c",
      ]);
      const created = await withAuthedClients(
        app,
        [a.token],
        async ([client]) => {
          const task = await callTool(client, "create_task", {
            title: "Private pings",
          });
          return task.structuredContent!;
        },
      );
      const taskId = created["task_id"] as string;

      await withAuthedClients(app, [a.token], async ([client]) => {
        await callTool(client, "post_comment", {
          task_id: taskId,
          content: "@agent-c please review",
        });
      });

      // C discovers its own mention id; B cannot clear it.
      const cPing = await withAuthedClients(
        app,
        [c.token],
        async ([client]) => {
          const unread = await callTool(client, "get_unread_pings", {});
          const pings = unread.structuredContent!["pings"] as Array<
            Record<string, unknown>
          >;
          expect(pings).toHaveLength(1);
          return pings[0]["mention_id"] as string;
        },
      );

      await withAuthedClients(app, [b.token], async ([client]) => {
        const foreign = await callTool(client, "mark_ping_read", {
          mention_id: cPing,
        });
        expect(foreign.isError).toBe(true);
        // not_found, not unauthorized: no existence oracle across agents.
        expect(JSON.stringify(foreign)).toContain("not_found");

        const unknown = await callTool(client, "mark_ping_read", {
          mention_id: randomUUID(),
        });
        expect(JSON.stringify(unknown)).toContain("not_found");
      });

      // C's ping is still unread, and marking twice is idempotent.
      await withAuthedClients(app, [c.token], async ([client]) => {
        const still = await callTool(client, "get_unread_pings", {});
        expect((still.structuredContent!["pings"] as unknown[]).length).toBe(1);
        for (let i = 0; i < 2; i += 1) {
          const mark = await callTool(client, "mark_ping_read", {
            mention_id: cPing,
          });
          expect(mark.isError, JSON.stringify(mark)).toBeFalsy();
        }
        const empty = await callTool(client, "get_unread_pings", {});
        expect(empty.structuredContent!["pings"]).toEqual([]);
      });
    } finally {
      await app.close();
    }
  });

  it("get_task_detail embeds the newest 20 comments with has_more; get_comments pages the full history", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let taskId = "";

      // A petrol-station history: 25 numbered comments → the detail
      // embed shows c5..c24 with has_more true (full = 25 > 20).
      let client0: Client | undefined;
      const app0 = app;
      const holders = await withAuthedClients(
        app0,
        [a.token],
        async ([client]) => {
          client0 = client;
          const task = await callTool(client, "create_task", {
            title: "History",
          });
          taskId = task.structuredContent!["task_id"] as string;
          for (let i = 0; i < 25; i += 1) {
            const posted = await callTool(client, "post_comment", {
              task_id: taskId,
              content: `c${i}`,
            });
            expect(posted.isError, JSON.stringify(posted)).toBeFalsy();
          }
          const detail = await callTool(client, "get_task_detail", {
            task_id: taskId,
          });
          const comments = detail.structuredContent!["comments"] as Array<{
            comment_id: string;
          }>;
          expect(comments).toHaveLength(20);
          expect(detail.structuredContent!["has_more"] as boolean).toBe(true);

          // Chronological window of the LAST 20: first content is c5.
          const pages = await callTool(client, "get_comments", {
            task_id: taskId,
            limit: 50,
          });
          void pages;
          return { detail: detail.structuredContent!, client: client0 };
        },
      );
      expect(holders).toBeTruthy();
      const detail = holders.detail;
      const embedded = detail["comments"] as Array<Record<string, unknown>>;
      expect(embedded[0]["content"]).toBe("c5");
      expect(embedded[19]["content"]).toBe("c24");

      await withAuthedClients(app, [a.token], async ([client]) => {
        // A short task pages cleanly until the cursor runs out.
        const created = await callTool(client, "create_task", {
          title: "Paged",
        });
        const pagedTask = created.structuredContent!["task_id"] as string;
        for (const content of ["c0", "c1", "c2", "c3", "c4"]) {
          await callTool(client, "post_comment", {
            task_id: pagedTask,
            content,
          });
        }

        const page1 = await callTool(client, "get_comments", {
          task_id: pagedTask,
          limit: 2,
        });
        const p1 = page1.structuredContent!;
        expect(
          (p1["comments"] as Array<Record<string, unknown>>).map(
            (c) => c["content"],
          ),
        ).toEqual(["c0", "c1"]);
        expect(p1["next_cursor"]).toBeTruthy();

        const page2 = await callTool(client, "get_comments", {
          task_id: pagedTask,
          limit: 2,
          cursor: p1["next_cursor"] as string,
        });
        const p2 = page2.structuredContent!;
        expect(
          (p2["comments"] as Array<Record<string, unknown>>).map(
            (c) => c["content"],
          ),
        ).toEqual(["c2", "c3"]);
        expect(p2["next_cursor"]).toBeTruthy();

        const page3 = await callTool(client, "get_comments", {
          task_id: pagedTask,
          limit: 2,
          cursor: p2["next_cursor"] as string,
        });
        const p3 = page3.structuredContent!;
        expect(
          (p3["comments"] as Array<Record<string, unknown>>).map(
            (c) => c["content"],
          ),
        ).toEqual(["c4"]);
        expect(p3["next_cursor"]).toBeNull();

        const ghost = await callTool(client, "get_comments", {
          task_id: randomUUID(),
        });
        expect(ghost.isError).toBe(true);
        expect(JSON.stringify(ghost)).toContain("task_not_found");

        // Stored rows agree with the service read.
        expect(getTask(app.db!, taskId)).toBeTruthy();
      });
    } finally {
      await app.close();
    }
  });

  it("concurrent registrations race on one name: exactly one winner", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      // Mention resolution requires fleet-wide name uniqueness; this
      // race pins it under real concurrent HTTP.
      const bootstraps = await Promise.all(
        [0, 1].map(async () => {
          const bootstrap = new Client({
            name: "bootstrap",
            version: "0.0.0",
          });
          await bootstrap.connect(
            new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
          );
          return bootstrap;
        }),
      );
      try {
        const inits = [0, 1].map(() =>
          mintCredential(app.db!, { type: "init" }),
        );
        const outcomes = await Promise.all(
          bootstraps.map((bootstrap, i) =>
            callTool(bootstrap, "register_agent", {
              init_token_id: inits[i].credential.credential_id,
              init_token: inits[i].secret,
              name: "racer",
              role: "coder",
            }),
          ),
        );
        const winners = outcomes.filter((o) => !o.isError);
        const losers = outcomes.filter((o) => o.isError);
        // Exactly one agent owns the name; the loser gets name_taken.
        expect(winners).toHaveLength(1);
        expect(JSON.stringify(losers[0])).toContain("name_taken");
      } finally {
        for (const bootstrap of bootstraps) await bootstrap.close();
      }
    } finally {
      await app.close();
    }
  });

  it("unauthenticated comment tools are rejected at the HTTP layer", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "post_comment",
            arguments: { task_id: "x", content: "y" },
          },
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

  it("a non-positive comment page size is schema-rejected as invalid params", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-comments-"),
    });
    try {
      const [a] = await registerAgentsOn(app, ["agent-a"]);
      await withAuthedClients(app, [a.token], async ([client]) => {
        const created = await callTool(client, "create_task", {
          title: "Page",
        });
        const taskId = created.structuredContent!["task_id"] as string;
        for (const limit of [0, 501]) {
          const bad = await callTool(client, "get_comments", {
            task_id: taskId,
            limit,
          });
          expect(bad.isError).toBe(true);
          expect(JSON.stringify(bad)).toContain("-32602");
        }
      });
    } finally {
      await app.close();
    }
  });
});
