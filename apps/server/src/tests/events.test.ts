import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { listen } from "../http/server.js";
import { bootstrapMaster } from "../identity/credentials.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

interface FleetEvent {
  event_id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

function wsUrl(app: { url: string }, query: string): string {
  return `${app.url.replace("http://", "ws://")}/api/events${query}`;
}

async function loginSession(
  app: { url: string },
  master: string,
): Promise<{ cookie: string; csrf: string }> {
  const res = await fetch(`${app.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ master_credential: master }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const body = (await res.json()) as { csrf_token: string };
  return {
    cookie: setCookie.split(";")[0].trim().split("=").slice(1).join("="),
    csrf: body.csrf_token,
  };
}

function openEventsSocket(
  app: { url: string },
  cookie: string,
  csrf: string,
  extra = "",
): WebSocket {
  const origin = app.url;
  return new WebSocket(`${wsUrl(app, `?csrf=${csrf}${extra}`)}`, {
    headers: { cookie: `__Host-polymer_admin=${cookie}`, origin },
  });
}

interface MessageCollector {
  next: (timeoutMs?: number) => Promise<FleetEvent>;
}

/**
 * Per-socket message queue, attached at construction. One-shot
 * waiters race push delivery: the server publishes an event before
 * the tool call that caused it returns, so a waiter attached after
 * the action can miss an already-arrived message. The collector
 * queues everything from birth; next() drains in order.
 */
function collect(socket: WebSocket): MessageCollector {
  const queue: FleetEvent[] = [];
  const waiters: Array<(event: FleetEvent) => void> = [];
  socket.on("message", (data) => {
    const event = JSON.parse(data.toString()) as FleetEvent;
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter(event);
    } else {
      queue.push(event);
    }
  });
  return {
    next: (timeoutMs = 5000): Promise<FleetEvent> => {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("timed out waiting for event")),
          timeoutMs,
        );
        waiters.push((event) => {
          clearTimeout(timer);
          resolve(event);
        });
      });
    },
  };
}

function waitForClose(
  socket: WebSocket,
  timeoutMs = 5000,
): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for close")),
      timeoutMs,
    );
    socket.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

function expectEnvelope(event: FleetEvent, type: string): void {
  expect(event.type).toBe(type);
  expect(typeof event.event_id).toBe("number");
  expect(typeof event.at).toBe("string");
  expect(typeof event.data).toBe("object");
}

describe("fleet events WebSocket (component 21)", () => {
  it("two clients receive task.created and task.updated live", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);

      const a = openEventsSocket(app, cookie, csrf);
      const b = openEventsSocket(app, cookie, csrf);
      const mailA = collect(a);
      const mailB = collect(b);
      await Promise.all([
        new Promise((r) => a.once("open", r)),
        new Promise((r) => b.once("open", r)),
      ]);
      const nextA = mailA.next();
      const nextB = mailB.next();

      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Live task" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });

      const [createdA, createdB] = await Promise.all([nextA, nextB]);
      for (const event of [createdA, createdB]) {
        expectEnvelope(event, "task.created");
        expect(event.data["task_id"]).toBe(taskId);
        expect(event.data["title"]).toBe("Live task");
      }
      expect(createdB.event_id).toBe(createdA.event_id);

      const updA = mailA.next();
      const updB = mailB.next();
      await withAuthedClients(app, [agent.token], async ([client]) => {
        await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        });
      });
      const [updatedA, updatedB] = await Promise.all([updA, updB]);
      for (const event of [updatedA, updatedB]) {
        expectEnvelope(event, "task.updated");
        expect(event.data["task_id"]).toBe(taskId);
        expect(event.data["status"]).toBe("in_progress");
      }
      expect(updatedA.event_id).toBeGreaterThan(createdA.event_id);

      a.close();
      b.close();
    } finally {
      await app.close();
    }
  });

  it("comment.created streams with content; agent.status_changed fires on register and disable", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);

      const socket = openEventsSocket(app, cookie, csrf);
      const mail = collect(socket);
      await new Promise((r) => socket.once("open", r));

      // Registration of a new agent publishes agent.status_changed.
      const regEvent = mail.next();
      const [fresh] = await registerAgentsOn(app, ["agent-b"]);
      void fresh;
      const registered = await regEvent;
      expectEnvelope(registered, "agent.status_changed");
      expect(registered.data["status"]).toBe("connecting");

      // Comment on a task publishes comment.created with content.
      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Discuss" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });
      // Drain the task.created event for the task above.
      const drained = await mail.next();
      expectEnvelope(drained, "task.created");

      const commentEvent = mail.next();
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const posted = (await client.callTool({
          name: "post_comment",
          arguments: { task_id: taskId, content: "hello fleet" },
        })) as unknown as { isError?: boolean };
        expect(posted.isError ?? false).toBe(false);
      });
      const comment = await commentEvent;
      expectEnvelope(comment, "comment.created");
      expect(comment.data["task_id"]).toBe(taskId);
      expect(comment.data["content"]).toBe("hello fleet");

      // Disable publishes agent.status_changed for the subtree.
      const disableEvent = mail.next();
      const disableRes = await fetch(
        `${app.url}/api/agents/${fresh.agentId}/disable`,
        {
          method: "POST",
          headers: {
            cookie: `__Host-polymer_admin=${cookie}`,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(disableRes.status).toBe(200);
      const disabled = await disableEvent;
      expectEnvelope(disabled, "agent.status_changed");
      expect(disabled.data["agent_id"]).toBe(fresh.agentId);
      expect(disabled.data["status"]).toBe("disabled");

      socket.close();
    } finally {
      await app.close();
    }
  });

  it("a resuming client replays missed events, then goes live", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);

      const socket = openEventsSocket(app, cookie, csrf);
      const mail = collect(socket);
      await new Promise((r) => socket.once("open", r));
      const first = mail.next();
      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "First" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });
      const seen = await first;
      const lastId = seen.event_id;
      socket.close();
      await new Promise((r) => socket.once("close", r));

      // Two events happen while disconnected.
      await withAuthedClients(app, [agent.token], async ([client]) => {
        await client.callTool({
          name: "post_comment",
          arguments: { task_id: taskId, content: "missed you" },
        });
        await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        });
      });

      // Resume with the cursor: both missed events replay in order.
      const resumed = openEventsSocket(app, cookie, csrf, `&cursor=${lastId}`);
      const resumedMail = collect(resumed);
      await new Promise((r) => resumed.once("open", r));
      const replay1 = (await resumedMail.next()) as FleetEvent;
      const replay2 = (await resumedMail.next()) as FleetEvent;
      expectEnvelope(replay1, "comment.created");
      expectEnvelope(replay2, "task.updated");
      expect(replay1.event_id).toBe(lastId + 1);
      expect(replay2.event_id).toBe(lastId + 2);

      // Then live again.
      const live = resumedMail.next();
      await withAuthedClients(app, [agent.token], async ([client]) => {
        await client.callTool({
          name: "update_task_status",
          arguments: {
            task_id: taskId,
            status: "done",
            lease_generation: replay2.data["lease_generation"] as number,
            expected_version: 2,
          },
        });
      });
      const done = await live;
      expectEnvelope(done, "task.updated");
      expect(done.data["status"]).toBe("done");

      resumed.close();
    } finally {
      await app.close();
    }
  });

  it("handshake failures close with 4401: bad csrf, no cookie, foreign origin", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);

      // Wrong CSRF.
      const badCsrf = openEventsSocket(app, cookie, "0".repeat(64));
      expect((await waitForClose(badCsrf)).code).toBe(4401);

      // No cookie at all.
      const noCookie = new WebSocket(wsUrl(app, `?csrf=${csrf}`), {
        headers: { origin: app.url },
      });
      expect((await waitForClose(noCookie)).code).toBe(4401);

      // Cross-origin upgrade rejected even with valid credentials.
      const foreign = new WebSocket(`${wsUrl(app, `?csrf=${csrf}`)}`, {
        headers: {
          cookie: `__Host-polymer_admin=${cookie}`,
          origin: "http://evil.example",
        },
      });
      expect((await waitForClose(foreign)).code).toBe(4401);

      // Unknown session cookie.
      const unknown = new WebSocket(wsUrl(app, `?csrf=${csrf}`), {
        headers: { cookie: "__Host-polymer_admin=dead.beef", origin: app.url },
      });
      expect((await waitForClose(unknown)).code).toBe(4401);
    } finally {
      await app.close();
    }
  });

  it("logout, revocation, and rotation close live sockets with 4401; disable does not", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const a = await loginSession(app, master);
      const b = await loginSession(app, master);

      const socketA = openEventsSocket(app, a.cookie, a.csrf);
      const socketB = openEventsSocket(app, b.cookie, b.csrf);
      await Promise.all([
        new Promise((r) => socketA.once("open", r)),
        new Promise((r) => socketB.once("open", r)),
      ]);

      // Logout closes only that session's socket.
      const closeA = waitForClose(socketA);
      const logout = await fetch(`${app.url}/api/auth/logout`, {
        method: "POST",
        headers: { cookie: `__Host-polymer_admin=${a.cookie}` },
      });
      expect(logout.status).toBe(200);
      expect((await closeA).code).toBe(4401);
      // B's socket survives its peer's logout.
      expect(socketB.readyState).toBe(WebSocket.OPEN);

      // Revoking B's credential closes B's socket.
      const closeB = waitForClose(socketB);
      const row = app
        .db!.prepare(
          "SELECT credential_id FROM credentials WHERE type = 'admin_session' AND status = 'active'",
        )
        .get() as { credential_id: string };
      const revoked = await fetch(
        `${app.url}/api/tokens/${row.credential_id}`,
        {
          method: "DELETE",
          headers: {
            cookie: `__Host-polymer_admin=${b.cookie}`,
            "x-csrf-token": b.csrf,
          },
        },
      );
      expect(revoked.status).toBe(200);
      expect((await closeB).code).toBe(4401);
    } finally {
      await app.close();
    }
  });

  it("master rotation closes every live socket", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const a = await loginSession(app, master);
      const b = await loginSession(app, master);
      const socketA = openEventsSocket(app, a.cookie, a.csrf);
      const socketB = openEventsSocket(app, b.cookie, b.csrf);
      await Promise.all([
        new Promise((r) => socketA.once("open", r)),
        new Promise((r) => socketB.once("open", r)),
      ]);

      const closeA = waitForClose(socketA);
      const closeB = waitForClose(socketB);
      const rotated = await fetch(`${app.url}/api/auth/rotate-master`, {
        method: "POST",
        headers: {
          cookie: `__Host-polymer_admin=${a.cookie}`,
          "x-csrf-token": a.csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(rotated.status).toBe(200);
      expect((await closeA).code).toBe(4401);
      expect((await closeB).code).toBe(4401);
    } finally {
      await app.close();
    }
  });

  it("disabling an unrelated subtree leaves admin sockets open", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      const socket = openEventsSocket(app, cookie, csrf);
      const mail = collect(socket);
      await new Promise((r) => socket.once("open", r));

      // No admin session is tied to an agent: disabling the subtree
      // affects zero sockets (the registry is precise, not kill-all).
      const res = await fetch(
        `${app.url}/api/agents/${agent.agentId}/disable`,
        {
          method: "POST",
          headers: {
            cookie: `__Host-polymer_admin=${cookie}`,
            "x-csrf-token": csrf,
            "content-type": "application/json",
          },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(socket.readyState).toBe(WebSocket.OPEN);

      // ...while a status event for the disable still streams.
      const event = await mail.next();
      expectEnvelope(event, "agent.status_changed");
      expect(event.data["status"]).toBe("disabled");
      socket.close();
    } finally {
      await app.close();
    }
  });

  it("the revalidation backstop closes sockets whose sessions expire", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
      eventsRevalidateMs: 50,
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const socket = openEventsSocket(app, cookie, csrf);
      await new Promise((r) => socket.once("open", r));

      // Expire the session without any explicit close trigger.
      app
        .db!.prepare(
          "UPDATE credentials SET expires_at = '2000-01-01T00:00:00.000Z' WHERE type = 'admin_session'",
        )
        .run();
      expect((await waitForClose(socket, 10000)).code).toBe(4401);
    } finally {
      await app.close();
    }
  });

  it("admin REST mutations publish to live sockets", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-events-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Admin-mutated" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });

      const socket = openEventsSocket(app, cookie, csrf);
      const mail = collect(socket);
      await new Promise((r) => socket.once("open", r));

      const headers = {
        cookie: `__Host-polymer_admin=${cookie}`,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      };
      const claimedEvent = mail.next();
      const claimRes = await fetch(`${app.url}/api/tasks/${taskId}/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(claimRes.status).toBe(200);
      const claimBody = (await claimRes.json()) as Record<string, unknown>;
      const claimed = await claimedEvent;
      expectEnvelope(claimed, "task.updated");
      expect(claimed.data["task_id"]).toBe(taskId);
      expect(claimed.data["coordinator"]).toBe(
        claimBody["coordinator"] as string,
      );

      const patchedEvent = mail.next();
      const patchRes = await fetch(`${app.url}/api/tasks/${taskId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          status: "done",
          expected_version: claimBody["version"],
          lease_generation: claimBody["lease_generation"],
          force: false,
        }),
      });
      expect(patchRes.status).toBe(200);
      const patched = await patchedEvent;
      expectEnvelope(patched, "task.updated");
      expect(patched.data["status"]).toBe("done");
      socket.close();
    } finally {
      await app.close();
    }
  });
});
