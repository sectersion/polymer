import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import {
  getTraceIdForComment,
  getTraceIdForTask,
  listSpansForComment,
  listSpansForTask,
  listTasksForTrace,
  parseTraceParent,
} from "../telemetry/correlation.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TASK_PARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const COMMENT_PARENT = `00-${TRACE_ID}-0af7651916cd43dd-01`;
const OTHER_TRACE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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

function otlpJson(traceId: string, spans: Array<Record<string, string>>) {
  return JSON.stringify({
    resourceSpans: [{ scopeSpans: [{ spans }] }],
  });
}

describe("task-trace correlation (component 25)", () => {
  it("from a task you can reliably identify its corresponding trace", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-correlation-"),
      telemetryBatchFlushMs: 25,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["correlation-agent"]);
      const ids = await withAuthedClients(app, [agent.token], async ([c]) => {
        const task = (await c.callTool({
          name: "create_task",
          arguments: { title: "correlated work", trace_parent: TASK_PARENT },
        })) as { structuredContent: Record<string, unknown> };
        const comment = (await c.callTool({
          name: "post_comment",
          arguments: {
            task_id: task.structuredContent["task_id"] as string,
            content: "handing off with trace",
            trace_parent: COMMENT_PARENT,
          },
        })) as { structuredContent: Record<string, unknown> };
        const detail = (await c.callTool({
          name: "get_task_detail",
          arguments: {
            task_id: task.structuredContent["task_id"] as string,
          },
        })) as { structuredContent: Record<string, unknown> };
        expect(detail.structuredContent["trace_parent"]).toBe(TASK_PARENT);
        return {
          taskId: task.structuredContent["task_id"] as string,
          commentId: comment.structuredContent["comment_id"] as string,
        };
      });

      // Spans from that trace arrive over real OTLP/HTTP.
      const res = await fetch(`${app.url}/otel/v1/traces`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agent.token}`,
          "content-type": "application/json",
        },
        body: otlpJson(TRACE_ID, [
          { traceId: TRACE_ID, spanId: "00f067aa0ba902b7", name: "root" },
          { traceId: TRACE_ID, spanId: "0af7651916cd43dd", name: "child" },
        ]),
      });
      expect(res.status).toBe(200);
      await waitFor(
        async () => listSpansForTask(app.db!, ids.taskId).length === 2,
      );

      // Task and comment both resolve to the same stored trace.
      expect(getTraceIdForTask(app.db!, ids.taskId)).toBe(TRACE_ID);
      expect(getTraceIdForComment(app.db!, ids.commentId)).toBe(TRACE_ID);
      const taskSpans = listSpansForTask(app.db!, ids.taskId);
      expect(taskSpans.map((s) => s.name).sort()).toEqual(["child", "root"]);
      expect(listSpansForComment(app.db!, ids.commentId)).toEqual(taskSpans);
      for (const s of taskSpans) {
        expect(s.traceId).toBe(TRACE_ID);
        expect(s.agentId).toBe(agent.agentId);
      }
      // Reverse direction: the trace identifies its task.
      const tasks = listTasksForTrace(app.db!, TRACE_ID);
      expect(tasks.map((t) => t.task_id)).toEqual([ids.taskId]);
      expect(listTasksForTrace(app.db!, OTHER_TRACE)).toEqual([]);
    } finally {
      await app.close();
    }
  }, 60000);

  it("missing, malformed, and unknown trace context never misidentifies", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-correlation-"),
      telemetryBatchFlushMs: 25,
    });
    try {
      const [agent] = await registerAgentsOn(app, ["correlation-agent"]);
      const ids = await withAuthedClients(app, [agent.token], async ([c]) => {
        const plain = (await c.callTool({
          name: "create_task",
          arguments: { title: "no context" },
        })) as { structuredContent: Record<string, unknown> };
        const odd = (await c.callTool({
          name: "create_task",
          arguments: { title: "odd context", trace_parent: "00-abc-def-01" },
        })) as { structuredContent: Record<string, unknown> };
        return {
          plain: plain.structuredContent["task_id"] as string,
          odd: odd.structuredContent["task_id"] as string,
        };
      });

      expect(getTraceIdForTask(app.db!, ids.plain)).toBeNull();
      expect(listSpansForTask(app.db!, ids.plain)).toEqual([]);
      // Stored opaque (write path unchanged), but unresolvable.
      expect(getTraceIdForTask(app.db!, ids.odd)).toBeNull();
      expect(listSpansForTask(app.db!, ids.odd)).toEqual([]);
      // Unknown ids resolve to nothing, never throw.
      expect(getTraceIdForTask(app.db!, "no-such-task")).toBeNull();
      expect(listSpansForTask(app.db!, "no-such-task")).toEqual([]);
      expect(getTraceIdForComment(app.db!, "no-such-comment")).toBeNull();
      expect(listSpansForComment(app.db!, "no-such-comment")).toEqual([]);
      expect(listTasksForTrace(app.db!, "not-a-trace-id")).toEqual([]);
      expect(listTasksForTrace(app.db!, "00-abc-def-01")).toEqual([]);
      // Neither task is claimed by any trace.
      expect(listTasksForTrace(app.db!, OTHER_TRACE)).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("parseTraceParent accepts strict W3C and rejects everything else", () => {
    expect(parseTraceParent(TASK_PARENT)).toEqual({
      traceId: TRACE_ID,
      parentSpanId: "00f067aa0ba902b7",
      sampled: true,
    });
    expect(
      parseTraceParent(`00-${TRACE_ID}-00f067aa0ba902b7-00`)?.sampled,
    ).toBe(false);
    // Uppercase is tolerated, normalized to lowercase.
    expect(parseTraceParent(TASK_PARENT.toUpperCase())?.traceId).toBe(TRACE_ID);
    for (const bad of [
      null,
      undefined,
      42,
      "",
      "00-abc-def-01",
      `01-${TRACE_ID}-00f067aa0ba902b7-01`,
      `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
      `00-${TRACE_ID}-${"0".repeat(16)}-01`,
      `00-${TRACE_ID.slice(2)}-00f067aa0ba902b7-01`,
      `00-${TRACE_ID}-00f067aa0ba902b7-0`,
      `00-${TRACE_ID}-00f067aa0ba902b7-01-extra`,
      `00-${TRACE_ID}-00f067aa0ba902b7`,
    ]) {
      expect(parseTraceParent(bad)).toBeNull();
    }
  });
});
