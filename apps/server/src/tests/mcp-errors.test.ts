import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listen } from "../http/server.js";
import { MCP_PATH } from "../mcp/index.js";
import { openDatabase } from "../database/db.js";
import { bootstrapMaster } from "../identity/credentials.js";
import { registerAgentTools } from "../mcp/agent-tools.js";
import { registerTaskTools } from "../mcp/task-tools.js";
import { registerCommentTools } from "../mcp/comment-tools.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

/**
 * Table-driven catalog-error coverage for the MCP tool modules
 * (audit #27): the throw/mapping branches in agent-tools /
 * task-tools / comment-tools that only fire on wrong inputs over the
 * real transport, one row per expected catalog code.
 */

type ToolCall = { name: string; arguments: Record<string, unknown> };

/** Text of an errored tool call: captured whether the SDK returns
 * isError content or throws the protocol error. */
async function errorText(call: Promise<unknown>): Promise<string> {
  try {
    const result = (await call) as { isError?: boolean; content?: unknown };
    if (result.isError) return JSON.stringify(result.content);
    return "NO_ERROR:" + JSON.stringify(result);
  } catch (err) {
    const e = err as { message?: string; data?: unknown };
    return String(e.message ?? "") + " " + JSON.stringify(e.data ?? {});
  }
}

describe("MCP tool error branches over the real transport (audit #27)", () => {
  it("the unauthenticated surface rejects every session-auth tool at the middleware: invalid_token", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-mcperr-"),
    });
    try {
      const client = new Client({ name: "anon", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
      );
      try {
        const cases: ToolCall[] = [
          { name: "create_task", arguments: { title: "X" } },
          { name: "claim_task", arguments: { task_id: "t" } },
          { name: "get_tasks", arguments: {} },
          { name: "get_task_detail", arguments: { task_id: "t" } },
          {
            name: "assign_task",
            arguments: {
              task_id: "t",
              agent_ids: ["a"],
              lease_generation: 1,
              expected_version: 1,
            },
          },
          {
            name: "transfer_coordinator",
            arguments: {
              task_id: "t",
              new_coordinator_id: "a",
              lease_generation: 1,
              expected_version: 1,
            },
          },
          { name: "request_unassignment", arguments: { task_id: "t" } },
          {
            name: "update_task_status",
            arguments: {
              task_id: "t",
              status: "done",
              lease_generation: 1,
              expected_version: 1,
            },
          },
          { name: "post_comment", arguments: { task_id: "t", content: "c" } },
          { name: "get_comments", arguments: { task_id: "t" } },
          { name: "get_unread_pings", arguments: {} },
          { name: "mark_ping_read", arguments: { mention_id: "m" } },
          { name: "get_agent_roster", arguments: {} },
          { name: "get_agent_info", arguments: { agent_id: "a" } },
          { name: "send_heartbeat", arguments: {} },
          { name: "register_subagent", arguments: { name: "n", role: "r" } },
        ];
        for (const call of cases) {
          // The transport middleware answers before the tool layer: a
          // missing bearer is invalid_token there, never a tool result.
          expect(await errorText(client.callTool(call)), call.name).toContain(
            "invalid_token",
          );
        }
      } finally {
        await client.close();
      }
    } finally {
      await app.close();
    }
  });

  it("catalog errors map one-to-one onto their codes (table-driven)", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-mcperr-"),
    });
    try {
      bootstrapMaster(app.db!);
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let taskId = "";
      let version = 0;
      let generation = 0;
      await withAuthedClients(app, [a.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Catalog" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
        const claimed = (await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        version = claimed.structuredContent["version"] as number;
        generation = claimed.structuredContent["lease_generation"] as number;
      });

      const rows: Array<{
        label: string;
        clientIndex: number;
        expectCode: string;
        call: ToolCall;
      }> = [
        {
          label: "claim an unknown task",
          clientIndex: 0,
          expectCode: "task_not_found",
          call: {
            name: "claim_task",
            arguments: { task_id: "does-not-exist" },
          },
        },
        {
          label: "claim a live-leased task as another agent",
          clientIndex: 1,
          expectCode: "task_already_claimed",
          call: { name: "claim_task", arguments: { task_id: taskId } },
        },
        {
          label: "detail of an unknown task",
          clientIndex: 0,
          expectCode: "task_not_found",
          call: { name: "get_task_detail", arguments: { task_id: "nope" } },
        },
        {
          label: "get_tasks with a garbage cursor",
          clientIndex: 0,
          expectCode: "invalid_cursor",
          call: { name: "get_tasks", arguments: { cursor: "garbage" } },
        },
        {
          label: "roster with a bogus status filter",
          clientIndex: 0,
          expectCode: "invalid_status",
          call: { name: "get_agent_roster", arguments: { status: "bogus" } },
        },
        {
          label: "info of an unknown agent",
          clientIndex: 0,
          expectCode: "agent_not_found",
          call: { name: "get_agent_info", arguments: { agent_id: "nope" } },
        },
        {
          label: "stale expected_version fences a status write",
          clientIndex: 0,
          expectCode: "version_mismatch",
          call: {
            name: "update_task_status",
            arguments: {
              task_id: taskId,
              status: "failed",
              lease_generation: generation,
              expected_version: version + 99,
            },
          },
        },
        {
          label: "a non-coordinator cannot write status under a live lease",
          clientIndex: 1,
          expectCode: "unauthorized",
          call: {
            name: "update_task_status",
            arguments: {
              task_id: taskId,
              status: "failed",
              lease_generation: generation,
              expected_version: version,
            },
          },
        },
        {
          label:
            "an impossible transition is invalid_status (in_progress -> to_do is not in the table)",
          clientIndex: 0,
          expectCode: "invalid_status",
          call: {
            name: "update_task_status",
            arguments: {
              task_id: taskId,
              status: "to_do",
              lease_generation: generation,
              expected_version: version,
            },
          },
        },
        {
          label: "assign by a non-coordinator",
          clientIndex: 1,
          expectCode: "unauthorized",
          call: {
            name: "assign_task",
            arguments: {
              task_id: taskId,
              agent_ids: [b.agentId],
              lease_generation: generation,
              expected_version: version,
            },
          },
        },
        {
          label: "assign to an unknown agent",
          clientIndex: 0,
          expectCode: "agent_not_found",
          call: {
            name: "assign_task",
            arguments: {
              task_id: taskId,
              agent_ids: ["ghost-agent"],
              lease_generation: generation,
              expected_version: version,
            },
          },
        },
        {
          label: "assign with a stale generation",
          clientIndex: 0,
          expectCode: "version_mismatch",
          call: {
            name: "assign_task",
            arguments: {
              task_id: taskId,
              agent_ids: [b.agentId],
              lease_generation: generation + 99,
              expected_version: version,
            },
          },
        },
        {
          label: "unassignment by an agent with no assignment row",
          clientIndex: 1,
          expectCode: "not_assigned",
          call: {
            name: "request_unassignment",
            arguments: { task_id: taskId },
          },
        },
        {
          label: "transfer to an unassigned agent",
          clientIndex: 0,
          expectCode: "not_assigned",
          call: {
            name: "transfer_coordinator",
            arguments: {
              task_id: taskId,
              new_coordinator_id: b.agentId,
              lease_generation: generation,
              expected_version: version,
            },
          },
        },
        {
          label: "comment on an unknown task",
          clientIndex: 0,
          expectCode: "task_not_found",
          call: {
            name: "post_comment",
            arguments: { task_id: "nope", content: "hello" },
          },
        },
        {
          label: "comments of an unknown task",
          clientIndex: 0,
          expectCode: "task_not_found",
          call: { name: "get_comments", arguments: { task_id: "nope" } },
        },
        {
          label: "comments with a garbage cursor",
          clientIndex: 0,
          expectCode: "invalid_cursor",
          call: {
            name: "get_comments",
            arguments: { task_id: taskId, cursor: "garbage" },
          },
        },
        {
          label: "marking an unknown ping read",
          clientIndex: 0,
          expectCode: "not_found",
          call: { name: "mark_ping_read", arguments: { mention_id: "nope" } },
        },
      ];

      await withAuthedClients(
        app,
        [a.token, b.token],
        async ([aClient, bClient]) => {
          for (const row of rows) {
            const client = row.clientIndex === 0 ? aClient : bClient;
            const text = await errorText(client.callTool(row.call as never));
            expect(text, row.label).toContain(row.expectCode);
            expect(text, row.label).not.toContain("NO_ERROR");
          }
        },
      );
    } finally {
      await app.close();
    }
  });

  it("a disabled agent's heartbeat is rejected as unauthorized", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-mcperr-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const res = await fetch(`${app.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ master_credential: master }),
      });
      const cookies = (
        res.headers as unknown as { getSetCookie: () => string[] }
      ).getSetCookie();
      const body = (await res.json()) as Record<string, unknown>;
      const admin = {
        cookie: cookies[0]!.split(";")[0],
        csrf: body["csrf_token"] as string,
      };
      const [agent] = await registerAgentsOn(app, ["doomed"]);
      await fetch(`${app.url}/api/agents/${agent.agentId}/disable`, {
        method: "POST",
        headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf },
        body: "{}",
      });
      await withAuthedClients(app, [agent.token], async ([client]) => {
        expect(
          await errorText(
            client.callTool({ name: "send_heartbeat", arguments: {} }),
          ),
        ).toContain("unauthorized");
      });
    } finally {
      await app.close();
    }
  });
});

/**
 * Guard-unit layer (audit #27): the `db === null` and
 * `caller === undefined` throws inside registered handlers cannot be
 * reached through the wire (the transport rejects or authenticates
 * first), so the handlers are collected with a stub server and asked
 * directly — the same registration contract, one level down.
 */
describe("MCP tool guards (audit #27)", () => {
  type Handler = (args: unknown, extra: unknown) => Promise<unknown>;

  const fakeEvents: never = {
    publish: () => undefined,
    closeSocketsFor: () => undefined,
    closeAll: () => undefined,
  } as never;

  function collectAll(
    db: Parameters<typeof registerAgentTools>[1],
  ): Array<[string, Handler]> {
    const recorded: Array<[string, Handler]> = [];
    const server: {
      registerTool: (name: string, opts: unknown, handler: unknown) => void;
    } = {
      registerTool: (name, _opts, handler) => {
        recorded.push([name, handler as Handler]);
      },
    };
    registerAgentTools(server as never, db, fakeEvents);
    registerTaskTools(server as never, db, fakeEvents);
    registerCommentTools(server as never, db, fakeEvents);
    return recorded;
  }

  it("every handler answers database_error when asked without a database", async () => {
    const recorded = collectAll(null);
    expect(recorded.length).toBeGreaterThanOrEqual(15);
    // ping touches no database: with a null db its identity guard
    // fires first, so the strict database_error below excludes it.
    for (const [name, handler] of recorded.filter(([n]) => n !== "ping")) {
      await expect(handler({}, {}), name).rejects.toThrow(/database_error/);
    }
  });

  const argsFor: Record<string, Record<string, unknown>> = {
    create_task: { title: "x" },
    claim_task: { task_id: "t" },
    get_tasks: {},
    get_task_detail: { task_id: "t" },
    assign_task: {
      task_id: "t",
      agent_ids: [],
      lease_generation: 1,
      expected_version: 1,
    },
    transfer_coordinator: {
      task_id: "t",
      new_coordinator_id: "a",
      lease_generation: 1,
      expected_version: 1,
    },
    request_unassignment: { task_id: "t" },
    update_task_status: {
      task_id: "t",
      status: "done",
      lease_generation: 1,
      expected_version: 1,
    },
    post_comment: { task_id: "t", content: "c" },
    mark_ping_read: { mention_id: "m" },
    get_comments: { task_id: "t" },
    get_agent_roster: {},
    get_agent_info: { agent_id: "a" },
    send_heartbeat: {},
    register_subagent: { name: "n", role: "r" },
    register_agent: {},
  };

  it("every session-auth handler answers unauthorized without a caller identity", async () => {
    const db = openDatabase(tempDbPath("polymer-guards-"));
    try {
      const recorded = collectAll(db);
      for (const [name, handler] of recorded) {
        if (name === "register_agent") continue; // bootstrap surface: honored identity is the same guard, asked next
        await expect(handler(argsFor[name], {}), name).rejects.toThrow(
          /unauthorized/,
        );
      }
      const [registerAgent] = recorded.filter(([n]) => n === "register_agent");
      await expect(
        registerAgent[1](argsFor.register_agent, {
          authInfo: { extra: { agentId: "someone" } },
        }),
      ).rejects.toThrow(/unauthorized/);
    } finally {
      db.close();
    }
  });
});
