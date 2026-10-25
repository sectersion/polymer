import { describe, expect, it } from "vitest";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listen } from "../http/server.js";
import { MCP_PATH } from "../mcp/index.js";
import { openDatabase } from "../database/db.js";
import { MAX_JSON_BODY_BYTES } from "../http/common.js";
import { bootstrapMaster } from "../identity/credentials.js";
import { bootstrapMasterCredential } from "../http/admin.js";
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

/// --- audit #27: specific error-path coverage behind the headline ---

describe("administrator mutation error paths (audit #27)", () => {
  it("the ops budget limits administrator mutations to 10/min per session, 429", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-ops-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      for (let i = 0; i < 10; i += 1) {
        const res = await adminFetch(app, "/api/tokens/init", {
          cookie,
          csrf,
          method: "POST",
          body: {},
        });
        expect(res.status).toBe(200);
      }
      const limited = await adminFetch(app, "/api/tokens/init", {
        cookie,
        csrf,
        method: "POST",
        body: {},
      });
      expect(limited.status).toBe(429);
      expect((await jsonBody(limited))["error"]).toBe("rate_limit_exceeded");
      // The consume happens BEFORE the CSRF check: a rate-limited
      // session CSP-probing CSRF strings gets the 429, not the 403.
      const probing = await adminFetch(app, "/api/tokens/init", {
        cookie,
        csrf: "0".repeat(64),
        method: "POST",
        body: {},
      });
      expect(probing.status).toBe(429);
    } finally {
      await app.close();
    }
  });

  it("agent PATCH validates the body and surfaces unknown ids as 404", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-patch-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);

      const empty = await adminFetch(app, `/api/agents/${agent.agentId}`, {
        cookie,
        csrf,
        method: "PATCH",
        body: {},
      });
      expect(empty.status).toBe(400);
      expect((await jsonBody(empty))["error"]).toBe("invalid_request");

      const typed = await adminFetch(app, `/api/agents/${agent.agentId}`, {
        cookie,
        csrf,
        method: "PATCH",
        body: { name: 3, role: false },
      });
      expect(typed.status).toBe(400);

      const unknown = await adminFetch(app, "/api/agents/ghost-agent", {
        cookie,
        csrf,
        method: "PATCH",
        body: { name: "renamed" },
      });
      expect(unknown.status).toBe(404);
      expect((await jsonBody(unknown))["error"]).toBe("agent_not_found");

      const ok = await adminFetch(app, `/api/agents/${agent.agentId}`, {
        cookie,
        csrf,
        method: "PATCH",
        body: { name: "renamed", role: "reviewer" },
      });
      expect(ok.status).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("task PATCH and bulk routes reject malformed bodies before touching tasks", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-bulk-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const authed = (
        path: string,
        body: Record<string, unknown>,
      ): Promise<Response> =>
        adminFetch(app, path, { cookie, csrf, method: "POST", body });

      // PATCH with missing fences → 400, and with a bogus status value.
      const noFences = await adminFetch(app, "/api/tasks/t1", {
        cookie,
        csrf,
        method: "PATCH",
        body: { status: "done" },
      });
      expect(noFences.status).toBe(400);
      expect((await jsonBody(noFences))["error"]).toBe("invalid_request");

      const badStatus = await adminFetch(app, "/api/tasks/t1", {
        cookie,
        csrf,
        method: "PATCH",
        body: { status: "bogus", expected_version: 1, lease_generation: 1 },
      });
      expect(badStatus.status).toBe(400);
      expect((await jsonBody(badStatus))["error"]).toBe("invalid_request");

      // Bulk routes: wrong shapes → 400; right shape → per-item rows.
      const bulkNoIds = await authed("/api/tasks/bulk-status", {
        status: "done",
      });
      expect(bulkNoIds.status).toBe(400);
      const bulkBadIds = await authed("/api/tasks/bulk-status", {
        task_ids: [1, 2],
        status: "done",
      });
      expect(bulkBadIds.status).toBe(400);
      const bulkBadStatus = await authed("/api/tasks/bulk-status", {
        task_ids: ["t1"],
        status: "bogus",
      });
      expect(bulkBadStatus.status).toBe(400);

      const assignNoIds = await authed("/api/tasks/bulk-assign", {
        task_ids: ["t1"],
        agent_ids: "agent-a",
      });
      expect(assignNoIds.status).toBe(400);

      // Valid bulk run over a real task (created + claimed by an agent
      // so in_progress → done is a legal transition).
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Bulk baby" },
        })) as unknown as { structuredContent: Record<string, unknown> };
        taskId = created.structuredContent["task_id"] as string;
        await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        });
      });
      const bulk = await authed("/api/tasks/bulk-status", {
        task_ids: [taskId],
        status: "done",
      });
      expect(bulk.status).toBe(200);
      const bulkBody = await jsonBody(bulk);
      const results = bulkBody["results"] as Array<Record<string, unknown>>;
      expect(results).toHaveLength(1);
      expect(results[0]["ok"]).toBe(true);
      // Every returned row matches the requested id (no fabricated rows).
      expect(results.filter((r) => r["ok"] === true).length).toBe(
        results.filter((r) => r["task_id"] === taskId).length,
      );
    } finally {
      await app.close();
    }
  });

  it("task POST mutations validate their bodies: assign/transfer fences, comment content", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-admin-task-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      let taskId = "";
      await withAuthedClients(app, [agent.token], async ([client]) => {
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "Bodies" },
        })) as unknown as { structuredContent: Record<string, unknown> };
        taskId = created.structuredContent["task_id"] as string;
      });
      const call = (tail: string, body: Record<string, unknown>) =>
        adminFetch(app, `/api/tasks/${taskId}/${tail}`, {
          cookie,
          csrf,
          method: "POST",
          body,
        });

      const assignNoFences = await call("assign", {
        agent_ids: [agent.agentId],
      });
      expect(assignNoFences.status).toBe(400);
      expect((await jsonBody(assignNoFences))["error"]).toBe("invalid_request");

      const assignBadIds = await call("assign", {
        agent_ids: "agent-a",
        expected_version: 1,
        lease_generation: 1,
      });
      expect(assignBadIds.status).toBe(400);

      const transferNoCoordinator = await call("transfer-coordinator", {
        expected_version: 1,
        lease_generation: 1,
      });
      expect(transferNoCoordinator.status).toBe(400);

      const emptyComment = await call("comments", { content: "   " });
      expect(emptyComment.status).toBe(400);
      expect((await jsonBody(emptyComment))["error"]).toBe("invalid_request");
    } finally {
      await app.close();
    }
  });
});

describe("admin surface: guards, payload caps, and degenerate branches (audit #27)", () => {
  const OVERSIZED = "x".repeat(MAX_JSON_BODY_BYTES + 16);

  it("a request with no admin cookie at all is 401 invalid_token", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-adm-nocookie-"),
    });
    try {
      const res = await adminFetch(app, "/api/agents");
      expect(res.status).toBe(401);
      expect((await jsonBody(res))["error"]).toBe("invalid_token");
      // Same for a malformed cookie header.
      const malformed = await adminFetch(app, "/api/agents", {
        cookie: "not-a-token",
      });
      expect(malformed.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("HTTPS-proxied logins advertise the Secure cookie attribute (X-Forwarded-Proto)", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-adm-secure-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      // node:http (not fetch): undici strips forbidden X-Forwarded-*
      // headers, so the proxy shape must be sent at the socket level.
      const login = (
        proto: string | string[],
      ): Promise<{ status: number; setCookie: string[] }> =>
        new Promise((resolve, reject) => {
          const body = JSON.stringify({ master_credential: master });
          const req = http.request(
            new URL(`${app.url}/api/auth/login`),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(body),
                "x-forwarded-proto": proto,
              },
            },
            (res) => {
              const headers = [...(res.headers["set-cookie"] ?? [])].join("\n");
              const chunks: string[] = [];
              res.on("data", (c: Buffer) => chunks.push(c.toString()));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  setCookie: headers.split("\n").filter(Boolean),
                }),
              );
              res.on("error", reject);
            },
          );
          req.on("error", reject);
          req.end(body);
        });

      for (const proto of ["https", ["https", "http"]]) {
        const res = await login(proto);
        expect(res.status).toBe(200);
        expect(res.setCookie[0]).toContain("Secure");
        expect(res.setCookie[0]).toContain("__Host-polymer_admin=");
      }
    } finally {
      await app.close();
    }
  });

  it("request bodies over the JSON cap answer 413 on every route that reads one", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-adm-cap-"),
      adminClaimEnabled: true,
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      const authed = (path: string, method: string) =>
        adminFetch(app, path, {
          cookie,
          csrf,
          method,
          body: { master_credential: OVERSIZED },
        });
      const cases: Array<[string, string]> = [
        ["/api/auth/rotate-master", "POST"],
        ["/api/tokens/init", "POST"],
        ["/api/tasks/bulk-status", "POST"],
        ["/api/tasks/bulk-assign", "POST"],
        ["/api/tasks/t1", "PATCH"],
        ["/api/tasks/t1/claim", "POST"],
        ["/api/tasks/t1/assign", "POST"],
        ["/api/tasks/t1/transfer-coordinator", "POST"],
        ["/api/tasks/t1/comments", "POST"],
        ["/api/agents/ag-1", "PATCH"],
      ];
      for (const [path, method] of cases) {
        const res = await authed(path, method);
        expect(res.status, path).toBe(413);
        expect((await jsonBody(res))["error"], path).toBe("payload_too_large");
      }
      // The same cap applies before any admin session exists.
      const raw = await fetch(`${app.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ master_credential: OVERSIZED }),
      });
      expect(raw.status).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("validation and idempotence branches around tokens/audit/reenable (audit #27)", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-adm-val-"),
      adminClaimEnabled: true,
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);

      // List validation: both paginators share the limit contract.
      const badTokens = await adminFetch(app, "/api/tokens?limit=abc", {
        cookie,
      });
      expect(badTokens.status).toBe(400);
      expect((await jsonBody(badTokens))["error"]).toBe("invalid_request");
      const bigTokens = await adminFetch(app, "/api/tokens?limit=501", {
        cookie,
      });
      expect(bigTokens.status).toBe(400);
      const badAudit = await adminFetch(app, "/api/audit?limit=abc", {
        cookie,
      });
      expect(badAudit.status).toBe(400);
      expect((await jsonBody(badAudit))["error"]).toBe("invalid_request");

      // Deleting an unknown token id: idempotent nothing, 404.
      const unknown = await adminFetch(app, "/api/tokens/ghost-id", {
        cookie,
        csrf,
        method: "DELETE",
      });
      expect(unknown.status).toBe(404);
      expect((await jsonBody(unknown))["error"]).toBe("not_found");

      // A session whose server-side row vanished gets 401 from the
      // CSRF read too.
      app
        .db!.prepare("DELETE FROM credentials WHERE type = 'admin_session'")
        .run();
      const noCsrf = await adminFetch(app, "/api/auth/csrf", { cookie });
      expect(noCsrf.status).toBe(401);
      expect((await jsonBody(noCsrf))["error"]).toBe("invalid_token");

      // Back in: reenable flips statuses to idle and repeats loudly.
      const fresh = await loginSession(app, master);
      const [agent] = await registerAgentsOn(app, ["agent-a"]);
      const disable = await adminFetch(
        app,
        `/api/agents/${agent.agentId}/disable`,
        {
          cookie: fresh.cookie,
          csrf: fresh.csrf,
          method: "POST",
          body: {},
        },
      );
      expect(disable.status).toBe(200);
      const row = app
        .db!.prepare("SELECT status FROM agents WHERE agent_id = ?")
        .get(agent.agentId) as { status: string };
      expect(row.status).toBe("disabled");

      const reenable = await adminFetch(
        app,
        `/api/agents/${agent.agentId}/reenable`,
        { cookie: fresh.cookie, csrf: fresh.csrf, method: "POST", body: {} },
      );
      expect(reenable.status).toBe(200);
      const rowAfter = app
        .db!.prepare("SELECT status FROM agents WHERE agent_id = ?")
        .get(agent.agentId) as { status: string };
      expect(rowAfter.status).toBe("idle");

      const bulkAssign = await adminFetch(app, "/api/tasks/bulk-assign", {
        cookie: fresh.cookie,
        csrf: fresh.csrf,
        method: "POST",
        body: { task_ids: [], agent_ids: [] },
      });
      expect(bulkAssign.status).toBe(200);
      expect((await jsonBody(bulkAssign))["results"]).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("an exhausted ops budget answers 429 on every mutation route", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-adm-429-"),
      adminClaimEnabled: true,
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const { cookie, csrf } = await loginSession(app, master);
      for (let i = 0; i < 10; i += 1) {
        await adminFetch(app, "/api/tokens/init", {
          cookie,
          csrf,
          method: "POST",
          body: {},
        });
      }
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ["/api/tokens/init", "POST", {}],
        ["/api/agents/ghost/disable", "POST", {}],
        ["/api/agents/ghost/reenable", "POST", {}],
        ["/api/agents/ghost", "PATCH", { name: "x" }],
        ["/api/tasks/bulk-status", "POST", { task_ids: ["t"], status: "done" }],
        [
          "/api/tasks/bulk-assign",
          "POST",
          { task_ids: ["t"], agent_ids: ["a"] },
        ],
        [
          "/api/tasks/t1",
          "PATCH",
          { status: "done", expected_version: 1, lease_generation: 1 },
        ],
        ["/api/tasks/t1/claim", "POST", {}],
        [
          "/api/tasks/t1/assign",
          "POST",
          { agent_ids: ["a"], expected_version: 1, lease_generation: 1 },
        ],
        [
          "/api/tasks/t1/transfer-coordinator",
          "POST",
          { new_coordinator_id: "a", expected_version: 1, lease_generation: 1 },
        ],
        ["/api/tasks/t1/comments", "POST", { content: "c" }],
      ];
      for (const [path, method, body] of cases) {
        const res = await adminFetch(app, path, { cookie, csrf, method, body });
        expect(res.status, path).toBe(429);
        expect((await jsonBody(res))["error"], path).toBe(
          "rate_limit_exceeded",
        );
      }
    } finally {
      await app.close();
    }
  });

  it("bootstrapMasterCredential prints the secret once through the reporter and never twice", () => {
    const db = openDatabase(tempDbPath("polymer-adm-boot-"));
    try {
      const lines: string[] = [];
      bootstrapMasterCredential(db, (line) => {
        lines.push(line);
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("polymer master credential");
      const secret = lines[0]!.split(":").pop()!.trim();
      const row = db
        .prepare("SELECT token_hash FROM credentials WHERE type='master'")
        .get() as { token_hash: string };
      expect(row.token_hash).not.toContain(secret);
      bootstrapMasterCredential(db, (line) => {
        lines.push(line);
      });
      expect(lines).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

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
      const { cookie, csrf } = await loginSession(app, master);
      const out = await adminFetch(app, "/api/auth/logout", {
        cookie,
        csrf,
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

      // Logout is state-changing too: no CSRF, no logout (the
      // session survives a missing token).
      const logoutNoCsrf = await adminFetch(app, "/api/auth/logout", {
        cookie,
        method: "POST",
      });
      expect(logoutNoCsrf.status).toBe(403);
      expect((await jsonBody(logoutNoCsrf))["error"]).toBe("csrf_invalid");
      expect((await adminFetch(app, "/api/agents", { cookie })).status).toBe(
        200,
      );

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
      const audits = (await jsonBody(audit))["entries"] as Array<
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
      const rows = audit["entries"] as Array<Record<string, unknown>>;
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
      const rows = audit["entries"] as Array<Record<string, unknown>>;
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
      const actions = (audit["entries"] as Array<Record<string, unknown>>).map(
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
      const listedBody = await jsonBody(listed);
      expect(Object.keys(listedBody).sort()).toEqual(["next_cursor", "tokens"]);
      const tokens = listedBody["tokens"] as Array<Record<string, unknown>>;
      expect(tokens.length).toBeGreaterThan(0);
      expect(listedBody["next_cursor"]).toBeNull();
      for (const row of tokens) {
        expect("token_hash" in row).toBe(false);
      }

      // Uniform list conventions: limit + cursor page the rows.
      const page1 = await jsonBody(
        await adminFetch(app, "/api/tokens?limit=1", { cookie }),
      );
      expect((page1["tokens"] as unknown[]).length).toBe(1);
      expect(page1["next_cursor"]).toBeTruthy();
      const page2 = await jsonBody(
        await adminFetch(
          app,
          `/api/tokens?limit=1&cursor=${page1["next_cursor"]}`,
          { cookie },
        ),
      );
      expect(
        (page2["tokens"] as Array<Record<string, unknown>>)[0]["credential_id"],
      ).not.toBe(
        (page1["tokens"] as Array<Record<string, unknown>>)[0]["credential_id"],
      );
      const badCursor = await adminFetch(app, "/api/tokens?cursor=garbage", {
        cookie,
      });
      expect(badCursor.status).toBe(400);
      expect((await jsonBody(badCursor))["error"]).toBe("invalid_cursor");

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
      // Additive combined line carries the same split OTP fields.
      expect(mintedBody["onboarding_token"]).toBe(
        `${mintedBody["init_token_id"]}:${mintedBody["init_token"]}`,
      );

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
