import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listen } from "../http/server.js";
import { MCP_PATH } from "../mcp/index.js";
import { bootstrapMaster } from "../identity/credentials.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
  type App,
} from "./test-support.js";

function cookieOf(setCookie: string): string {
  const pair = setCookie.split(";")[0].trim();
  const eq = pair.indexOf("=");
  // The bare token value; adminFetch re-attaches the cookie name.
  return eq === -1 ? pair : pair.slice(eq + 1).trim();
}

function setCookies(res: Response): string[] {
  const anyHeaders = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single === null ? [] : [single];
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function login(
  app: App,
  master: unknown,
): Promise<{
  res: Response;
  body: Record<string, unknown>;
  cookies: string[];
}> {
  const res = await fetch(`${app.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ master_credential: master }),
  });
  const cookies = setCookies(res);
  return { res, body: await jsonBody(res), cookies };
}

async function adminFetch(
  app: App,
  path: string,
  opts: {
    cookie?: string;
    csrf?: string;
    method?: string;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie !== undefined) {
    headers["cookie"] = `__Host-polymer_admin=${opts.cookie}`;
  }
  if (opts.csrf !== undefined) {
    headers["x-csrf-token"] = opts.csrf;
  }
  return fetch(`${app.url}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      ...headers,
      ...(opts.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

async function loginSession(
  app: App,
  master: string,
): Promise<{ cookie: string; csrf: string }> {
  const { res, body, cookies } = await login(app, master);
  expect(res.status).toBe(200);
  expect(cookies.length).toBeGreaterThan(0);
  return {
    cookie: cookieOf(cookies[0]),
    csrf: body["csrf_token"] as string,
  };
}

describe("administrator authentication (component 19)", () => {
  it("master bootstrap mints once and persists only a scrypt hash", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const first = bootstrapMaster(app.db!);
      expect(typeof first).toBe("string");
      expect(first!.length).toBeGreaterThan(0);
      // Second bootstrap is a no-op: the row already exists.
      expect(bootstrapMaster(app.db!)).toBeUndefined();
      const row = app
        .db!.prepare("SELECT * FROM credentials WHERE type = 'master'")
        .get() as Record<string, unknown>;
      expect(row["agent_id"]).toBeNull();
      expect(String(row["token_hash"]).startsWith("$scrypt$")).toBe(true);
      // Plaintext is never persisted.
      expect(JSON.stringify(row)).not.toContain(first!);
    } finally {
      await app.close();
    }
  });

  it("successful login mints a session cookie and CSRF token; failures are indistinguishable", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { res, body, cookies } = await login(app, master);
      expect(res.status).toBe(200);
      expect(body["success"]).toBe(true);
      expect(typeof body["csrf_token"]).toBe("string");
      expect(body["expires_in"]).toBe(28800);
      expect(typeof body["expires_at"]).toBe("string");
      const setCookie = cookies[0];
      expect(setCookie.startsWith("__Host-polymer_admin=")).toBe(true);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/");
      expect(setCookie).toContain("Max-Age=28800");
      // Loopback listener: no Secure flag.
      expect(setCookie).not.toContain("Secure");

      // The session authenticates reads.
      const agents = await adminFetch(app, "/api/agents", {
        cookie: cookieOf(setCookie),
      });
      expect(agents.status).toBe(200);

      // Wrong master, missing body, and empty credential are
      // indistinguishable: all 401 invalid_token.
      for (const bad of ["wrong-secret", undefined, ""]) {
        const failed = await login(app, bad);
        expect(failed.res.status).toBe(401);
        expect(failed.body["error"]).toBe("invalid_token");
      }
    } finally {
      await app.close();
    }
  });

  it("login is rate-limited: 5 per minute per IP, then 429", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      bootstrapMaster(app.db!);
      for (let i = 0; i < 5; i += 1) {
        const failed = await login(app, "wrong-secret");
        expect(failed.res.status).toBe(401);
      }
      const limited = await login(app, "wrong-secret");
      expect(limited.res.status).toBe(429);
      expect(limited.body["error"]).toBe("rate_limit_exceeded");
      expect(limited.body["retry_after"]).toBe(60);
    } finally {
      await app.close();
    }
  });

  it("expired and revoked sessions stop authenticating", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie } = await loginSession(app, master);

      // Expire the session row server-side.
      app
        .db!.prepare(
          "UPDATE credentials SET expires_at = '2000-01-01T00:00:00.000Z' WHERE type = 'admin_session'",
        )
        .run();
      expect((await adminFetch(app, "/api/agents", { cookie })).status).toBe(
        401,
      );

      // Fresh session, then revoked.
      const fresh = await loginSession(app, master);
      app
        .db!.prepare(
          "UPDATE credentials SET status = 'revoked' WHERE type = 'admin_session'",
        )
        .run();
      const res = await adminFetch(app, "/api/agents", {
        cookie: fresh.cookie,
      });
      expect(res.status).toBe(401);
      expect((await jsonBody(res))["error"]).toBe("invalid_token");
    } finally {
      await app.close();
    }
  });

  it("logout deletes the session row and clears the cookie", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie } = await loginSession(app, master);
      const out = await adminFetch(app, "/api/auth/logout", {
        cookie,
        method: "POST",
      });
      expect(out.status).toBe(200);
      expect((await jsonBody(out))["success"]).toBe(true);
      const cleared = setCookies(out)[0];
      expect(cleared).toContain("Max-Age=0");
      expect(cleared).toContain("HttpOnly");
      expect(cleared).toContain("SameSite=Lax");
      // The session row is gone: reads fail.
      expect((await adminFetch(app, "/api/agents", { cookie })).status).toBe(
        401,
      );
      const remaining = app
        .db!.prepare(
          "SELECT COUNT(*) AS n FROM credentials WHERE type = 'admin_session'",
        )
        .get() as { n: number };
      expect(remaining.n).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("mutations require CSRF: missing or wrong token is 403 csrf_invalid", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);

      // GET /api/auth/csrf re-reads the same token.
      const csrfRes = await adminFetch(app, "/api/auth/csrf", { cookie });
      expect(csrfRes.status).toBe(200);
      expect((await jsonBody(csrfRes))["csrf_token"]).toBe(csrf);

      const noToken = await adminFetch(app, "/api/tokens/init", {
        cookie,
        method: "POST",
        body: {},
      });
      expect(noToken.status).toBe(403);
      expect((await jsonBody(noToken))["error"]).toBe("csrf_invalid");

      const wrongToken = await adminFetch(app, "/api/tokens/init", {
        cookie,
        csrf: "0".repeat(64),
        method: "POST",
        body: {},
      });
      expect(wrongToken.status).toBe(403);
      expect((await jsonBody(wrongToken))["error"]).toBe("csrf_invalid");

      // Correct token proceeds.
      const ok = await adminFetch(app, "/api/tokens/init", {
        cookie,
        csrf,
        method: "POST",
        body: {},
      });
      expect(ok.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rotate-master returns a new secret once, revokes all sessions, and audits", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const a = await loginSession(app, master);
      const b = await loginSession(app, master);

      const rotated = await adminFetch(app, "/api/auth/rotate-master", {
        cookie: a.cookie,
        csrf: a.csrf,
        method: "POST",
        body: {},
      });
      expect(rotated.status).toBe(200);
      const rotatedBody = await jsonBody(rotated);
      const newMaster = rotatedBody["master_credential"] as string;
      expect(typeof newMaster).toBe("string");
      expect(typeof rotatedBody["rotated_at"]).toBe("string");
      expect(newMaster).not.toBe(master);
      // Only the new hash persists.
      const row = app
        .db!.prepare("SELECT * FROM credentials WHERE type = 'master'")
        .get() as Record<string, unknown>;
      expect(JSON.stringify(row)).not.toContain(newMaster);

      // Old master fails, new master works — and the new login
      // doubles as the fresh session for the audit read (the per-IP
      // login budget is 5: two logins + rotate + old-fails + this).
      expect((await login(app, master)).res.status).toBe(401);
      const fresh = await loginSession(app, newMaster);

      // Every live admin session is dead — including the rotator's.
      for (const cookie of [a.cookie, b.cookie]) {
        expect((await adminFetch(app, "/api/agents", { cookie })).status).toBe(
          401,
        );
      }

      // Exactly one master.rotated audit row, readable with the new session.
      const audit = await adminFetch(app, "/api/audit", {
        cookie: fresh.cookie,
      });
      expect(audit.status).toBe(200);
      const audits = (await jsonBody(audit))["audits"] as Array<
        Record<string, unknown>
      >;
      const rotations = audits.filter((r) => r["action"] === "master.rotated");
      expect(rotations).toHaveLength(1);
      expect(rotations[0]["actor_type"]).toBe("admin_session");
    } finally {
      await app.close();
    }
  });

  it("admin bypass mutations carry audit rows; normal path enforces fences", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const authed = (
        path: string,
        opts: { method?: string; body?: Record<string, unknown> } = {},
      ): Promise<Response> =>
        adminFetch(app, path, {
          cookie,
          csrf,
          method: opts.method,
          body: opts.body,
        });

      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      let taskId = "";
      let version = 0;
      let generation = 0;
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Stuck lease" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
        // Force never overrides transition legality: claim first so the
        // task is in_progress before the bypass moves it to done.
        const claimed = (await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        version = claimed.structuredContent["version"] as number;
        generation = claimed.structuredContent["lease_generation"] as number;
      });

      // Normal-path PATCH validates fences.
      const stale = await authed(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: {
          status: "done",
          expected_version: version + 99,
          lease_generation: generation,
        },
      });
      expect(stale.status).toBe(409);
      expect((await jsonBody(stale))["error"]).toBe("version_mismatch");

      // Force bypass skips the fences and writes exactly one audit row.
      const forced = await authed(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: {
          status: "done",
          expected_version: -1,
          lease_generation: -1,
          force: true,
        },
      });
      expect(forced.status).toBe(200);
      const forcedBody = await jsonBody(forced);
      expect(forcedBody["status"]).toBe("done");
      expect(forcedBody["version"]).toBe(version + 1);

      const audit = await jsonBody(
        await adminFetch(app, `/api/audit?task_id=${taskId}`, { cookie }),
      );
      const rows = audit["audits"] as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]["action"]).toBe("task.status.bypass");
      expect(rows[0]["actor_type"]).toBe("admin_session");
      const before = JSON.parse(rows[0]["before"] as string) as Record<
        string,
        unknown
      >;
      const after = JSON.parse(rows[0]["after"] as string) as Record<
        string,
        unknown
      >;
      expect(before["status"]).toBe("in_progress");
      expect(after["status"]).toBe("done");
      // Audit snapshots are task columns only — never comment bodies.
      expect(Object.keys(before).sort()).toEqual(Object.keys(after).sort());
      expect("content" in before).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("admin claim resets the lease without changing the coordinator", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      let taskId = "";
      let coordinator = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Lease reset" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
        coordinator = created.structuredContent["coordinator"] as string;
      });

      const claimed = await adminFetch(app, `/api/tasks/${taskId}/claim`, {
        cookie,
        csrf,
        method: "POST",
        body: { lease_duration_seconds: 600 },
      });
      expect(claimed.status).toBe(200);
      const body = await jsonBody(claimed);
      expect(body["status"]).toBe("in_progress");
      // A lease reset, not an ownership change.
      expect(body["coordinator"]).toBe(coordinator);
      expect(body["lease_generation"]).toBe(2);
      expect(body["task_id"]).toBe(taskId);

      const audit = await jsonBody(
        await adminFetch(app, `/api/audit?task_id=${taskId}`, { cookie }),
      );
      const rows = audit["audits"] as Array<Record<string, unknown>>;
      expect(rows.map((r) => r["action"])).toContain("task.claim.bypass");
    } finally {
      await app.close();
    }
  });

  it("admin assign/transfer validate normally and bypass with force", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let taskId = "";
      await withAuthedClients(app, [a.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Admin crew" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });

      const call = (
        tail: string,
        body: Record<string, unknown>,
      ): Promise<Response> =>
        adminFetch(app, `/api/tasks/${taskId}/${tail}`, {
          cookie,
          csrf,
          method: "POST",
          body,
        });

      // Normal assign validates fences like the MCP tool.
      const assigned = await call("assign", {
        agent_ids: [b.agentId],
        expected_version: 1,
        lease_generation: 1,
      });
      expect(assigned.status).toBe(200);
      expect(
        ((await jsonBody(assigned))["assigned_to"] as unknown[]).length,
      ).toBe(1);

      // Force assign bypasses stale fences and audits.
      const forcedAssign = await call("assign", {
        agent_ids: [a.agentId],
        expected_version: -1,
        lease_generation: -1,
        force: true,
      });
      expect(forcedAssign.status).toBe(200);

      // Normal transfer validates fences and requires a live lease —
      // and bumps the generation like the MCP tool (ownership epoch).
      const transferred = await call("transfer-coordinator", {
        new_coordinator_id: b.agentId,
        expected_version: 3,
        lease_generation: 2,
      });
      expect(transferred.status).toBe(200);
      const transferredBody = await jsonBody(transferred);
      expect(transferredBody["coordinator"]).toBe(b.agentId);
      expect(transferredBody["lease_generation"]).toBe(3);

      // Force transfer back needs no live lease and writes its audit
      // row even with garbage fences.
      const forcedTransfer = await call("transfer-coordinator", {
        new_coordinator_id: a.agentId,
        expected_version: -1,
        lease_generation: -1,
        force: true,
      });
      expect(forcedTransfer.status).toBe(200);
      const forcedTransferBody = await jsonBody(forcedTransfer);
      expect(forcedTransferBody["coordinator"]).toBe(a.agentId);
      expect(forcedTransferBody["lease_generation"]).toBe(4);

      const audit = await jsonBody(
        await adminFetch(app, `/api/audit?task_id=${taskId}`, { cookie }),
      );
      const actions = (audit["audits"] as Array<Record<string, unknown>>).map(
        (r) => r["action"],
      );
      expect(actions).toContain("task.assign.bypass");
      expect(actions).toContain("task.transfer.bypass");
    } finally {
      await app.close();
    }
  });

  it("admin comments post as human and resolve mentions like the MCP tool", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [a, b] = await registerAgentsOn(app, ["agent-a", "agent-b"]);
      let taskId = "";
      await withAuthedClients(app, [a.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Handoff" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });

      const posted = await adminFetch(app, `/api/tasks/${taskId}/comments`, {
        cookie,
        csrf,
        method: "POST",
        body: { content: "@agent-b please take a look" },
      });
      expect(posted.status).toBe(200);
      const body = await jsonBody(posted);
      expect(body["sender_agent_id"]).toBeNull();
      expect(body["mentions"]).toEqual([b.agentId]);

      // The row agrees: sender_type human, NULL agent.
      const row = app
        .db!.prepare("SELECT * FROM comments WHERE comment_id = ?")
        .get(body["comment_id"]) as Record<string, unknown>;
      expect(row["sender_type"]).toBe("human");
      expect(row["sender_agent_id"]).toBeNull();

      // B discovers the ping over MCP.
      await withAuthedClients(app, [b.token], async ([client]) => {
        const pings = (await client.callTool({
          name: "get_unread_pings",
          arguments: {},
        })) as unknown as {
          structuredContent: { pings: Array<Record<string, unknown>> };
        };
        expect(pings.structuredContent.pings).toHaveLength(1);
      });
    } finally {
      await app.close();
    }
  });

  it("tokens routes list metadata only; init mints a usable OTP; delete revokes", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);

      const listed = await adminFetch(app, "/api/tokens", { cookie });
      expect(listed.status).toBe(200);
      const tokens = (await jsonBody(listed))["tokens"] as Array<
        Record<string, unknown>
      >;
      expect(tokens.length).toBeGreaterThan(0);
      for (const row of tokens) {
        expect("token_hash" in row).toBe(false);
      }

      const minted = await adminFetch(app, "/api/tokens/init", {
        cookie,
        csrf,
        method: "POST",
        body: {},
      });
      expect(minted.status).toBe(200);
      const mintedBody = await jsonBody(minted);
      expect(typeof mintedBody["init_token"]).toBe("string");
      expect(mintedBody["expires_in"]).toBe(600);

      // The OTP registers a real agent over MCP.
      const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
      await bootstrap.connect(
        new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
      );
      try {
        const reg = (await bootstrap.callTool({
          name: "register_agent",
          arguments: {
            init_token_id: mintedBody["init_token_id"],
            init_token: mintedBody["init_token"],
            name: "via-admin",
            role: "coder",
          },
        })) as { structuredContent: Record<string, unknown> };
        expect(reg.structuredContent["agent_id"]).toBeTruthy();
        expect(typeof reg.structuredContent["session_token"]).toBe("string");
      } finally {
        await bootstrap.close();
      }

      // Delete revokes the init token: reuse fails as already-used.
      const credentialId = mintedBody["init_token_id"] as string;
      const deleted = await adminFetch(app, `/api/tokens/${credentialId}`, {
        cookie,
        csrf,
        method: "DELETE",
      });
      expect(deleted.status).toBe(200);
      const row = app
        .db!.prepare("SELECT status FROM credentials WHERE credential_id = ?")
        .get(credentialId) as { status: string };
      expect(row.status).toBe("revoked");
    } finally {
      await app.close();
    }
  });

  it("admin claim can be disabled: the kill-switch answers 403", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
      adminClaimEnabled: false,
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "No admin claim" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });
      const claimed = await adminFetch(app, `/api/tasks/${taskId}/claim`, {
        cookie,
        csrf,
        method: "POST",
        body: {},
      });
      expect(claimed.status).toBe(403);
      expect((await jsonBody(claimed))["error"]).toBe("unauthorized");
    } finally {
      await app.close();
    }
  });

  it("non-GET /api/audit is 405 like every other read route", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const res = await adminFetch(app, "/api/audit", {
        cookie,
        csrf,
        method: "POST",
        body: {},
      });
      expect(res.status).toBe(405);
      expect((await jsonBody(res))["error"]).toBe("method_not_allowed");
    } finally {
      await app.close();
    }
  });

  it("disable freezes a subtree, releases leases, and audits per batch", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [parent] = await registerAgentsOn(app, ["parent"]);
      let childA = "";
      let childAToken = "";
      let childB = "";
      let grandchild = "";
      let taskId = "";
      await withAuthedClients(app, [parent.token], async ([client]) => {
        const spawn = async (
          name: string,
        ): Promise<{ id: string; token: string }> => {
          const sub = (await client.callTool({
            name: "register_subagent",
            arguments: { name, role: "coder" },
          })) as unknown as {
            structuredContent: Record<string, unknown>;
          };
          return {
            id: sub.structuredContent["agent_id"] as string,
            token: sub.structuredContent["session_token"] as string,
          };
        };
        ({ id: childA, token: childAToken } = await spawn("child-a"));
        ({ id: childB } = await spawn("child-b"));
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Parent work" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        taskId = created.structuredContent["task_id"] as string;
      });
      await withAuthedClients(app, [childAToken], async ([client]) => {
        const sub = (await client.callTool({
          name: "register_subagent",
          arguments: { name: "grandchild", role: "coder" },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        grandchild = sub.structuredContent["agent_id"] as string;
      });

      const res = await adminFetch(
        app,
        `/api/agents/${parent.agentId}/disable`,
        {
          cookie,
          csrf,
          method: "POST",
          body: {},
        },
      );
      expect(res.status).toBe(200);
      const body = await jsonBody(res);
      expect(body["success"]).toBe(true);
      expect(body["complete"]).toBe(true);
      expect(body["disabled_count"]).toBe(4);

      const statuses = app
        .db!.prepare("SELECT agent_id, status FROM agents")
        .all() as Array<{ agent_id: string; status: string }>;
      expect(statuses.every((r) => r.status === "disabled")).toBe(true);
      expect(statuses.map((r) => r.agent_id).sort()).toEqual(
        [parent.agentId, childA, childB, grandchild].sort(),
      );

      // Lease release: coordinator kept, lease nulled, generation+1.
      const task = app
        .db!.prepare("SELECT * FROM tasks WHERE task_id = ?")
        .get(taskId) as Record<string, unknown>;
      expect(task["coordinator"]).toBe(parent.agentId);
      expect(task["lease_expires_at"]).toBeNull();
      expect(task["lease_generation"]).toBe(2);

      // One audit batch row for the single batch.
      const audits = app
        .db!.prepare(
          "SELECT * FROM audit_log WHERE action = 'agent.disable.batch'",
        )
        .all() as Array<Record<string, unknown>>;
      expect(audits).toHaveLength(1);
      const after = JSON.parse(audits[0]["after"] as string) as Record<
        string,
        unknown
      >;
      expect(after["disabled_count"]).toBe(4);

      // Idempotent retry: nothing new disabled, still complete.
      const retry = await adminFetch(
        app,
        `/api/agents/${parent.agentId}/disable`,
        { cookie, csrf, method: "POST", body: {} },
      );
      expect(retry.status).toBe(200);
      const retryBody = await jsonBody(retry);
      expect(retryBody["disabled_count"]).toBe(0);
      expect(retryBody["complete"]).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("a disabled subtree cannot spawn; unknown agents are 404", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [parent] = await registerAgentsOn(app, ["parent"]);
      await adminFetch(app, `/api/agents/${parent.agentId}/disable`, {
        cookie,
        csrf,
        method: "POST",
        body: {},
      });

      // Spawns under a disabled parent fail in the same transaction
      // as the insert — parent_disabled, never a 500.
      await withAuthedClients(app, [parent.token], async ([client]) => {
        const spawned = (await client.callTool({
          name: "register_subagent",
          arguments: { name: "escapee", role: "coder" },
        })) as unknown as { isError?: boolean };
        expect(spawned.isError).toBe(true);
        expect(JSON.stringify(spawned)).toContain("parent_disabled");
      });
      const escapee = app
        .db!.prepare("SELECT agent_id FROM agents WHERE name = 'escapee'")
        .get() as { agent_id: string } | undefined;
      expect(escapee).toBeUndefined();

      const unknown = await adminFetch(
        app,
        "/api/agents/does-not-exist/disable",
        {
          cookie,
          csrf,
          method: "POST",
          body: {},
        },
      );
      expect(unknown.status).toBe(404);
      expect((await jsonBody(unknown))["error"]).toBe("agent_not_found");
    } finally {
      await app.close();
    }
  });
});
