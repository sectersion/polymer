import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { mintCredential } from "./credentials.js";
import { RefreshLimiter } from "./rate-limit.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-refresh-")), "test.db");
}

const REFRESH_PATH = "/api/tokens/refresh";

const NO_BODY: unique symbol = Symbol("no-body");

interface Registered {
  agentId: string;
  sessionToken: string;
  reconnectSecret: string;
}

// One MCP server accepts one transport session: registration gets its
// own server on the shared SQLite file.
async function registerAgent(
  dbPath: string,
  name: string,
): Promise<Registered> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
  const client = new Client({ name: "bootstrap", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  try {
    const { credential, secret } = mintCredential(app.db!, { type: "init" });
    const result = (await client.callTool({
      name: "register_agent",
      arguments: {
        init_token_id: credential.credential_id,
        init_token: secret,
        name,
        role: "coder",
      },
    })) as { structuredContent: Record<string, unknown> };
    return {
      agentId: result.structuredContent["agent_id"] as string,
      sessionToken: result.structuredContent["session_token"] as string,
      reconnectSecret: result.structuredContent["reconnect_secret"] as string,
    };
  } finally {
    await client.close();
    await app.close();
  }
}

async function postRefresh(
  url: string,
  auth: string | undefined,
  // NO_BODY omits the HTTP body entirely; the default {} sends a
  // valid empty object (explicit undefined would trigger the default,
  // so the missing-body case needs the sentinel).
  body: unknown = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}${REFRESH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body === NO_BODY ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  return { status: res.status, json };
}

async function pingWith(dbPath: string, token: string): Promise<unknown> {
  const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: "ping", arguments: {} });
    return (result as { structuredContent?: unknown }).structuredContent;
  } finally {
    await client.close();
    await app.close();
  }
}

describe("Reconnect credential rotation (component 9)", () => {
  it("credential A refreshes to B; B works and A replays fail", async () => {
    const dbPath = tempDbPath();
    const a = await registerAgent(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const first = await postRefresh(app.url, a.reconnectSecret);
      expect(first.status).toBe(200);
      expect(first.json["agent_id"]).toBe(a.agentId);
      expect(typeof first.json["session_token"]).toBe("string");
      expect(typeof first.json["reconnect_secret"]).toBe("string");
      expect(first.json["expires_in"]).toBe(604800);
      expect(first.json["reconnect_expires_in"]).toBe(2592000);
      expect(first.json["session_token"]).not.toBe(a.sessionToken);
      expect(first.json["reconnect_secret"]).not.toBe(a.reconnectSecret);

      // The old reconnect credential cannot be replayed.
      const replay = await postRefresh(app.url, a.reconnectSecret);
      expect(replay.status).toBe(401);
      expect(replay.json["error"]).toBe("reconnect_already_used");

      // Chained refresh with the new credential works; A stays dead.
      const second = await postRefresh(
        app.url,
        first.json["reconnect_secret"] as string,
      );
      expect(second.status).toBe(200);
      const replayAgain = await postRefresh(app.url, a.reconnectSecret);
      expect(replayAgain.status).toBe(401);
      expect(replayAgain.json["error"]).toBe("reconnect_already_used");
    } finally {
      await app.close();
    }
  });

  it("new session works on ping; old session stays valid (reconnect-only invalidation)", async () => {
    const dbPath = tempDbPath();
    const a = await registerAgent(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    let freshSession: string;
    try {
      const out = await postRefresh(app.url, a.reconnectSecret);
      expect(out.status).toBe(200);
      freshSession = out.json["session_token"] as string;
    } finally {
      await app.close();
    }
    expect(await pingWith(dbPath, freshSession!)).toEqual({
      ok: true,
      agent_id: a.agentId,
    });
    expect(await pingWith(dbPath, a.sessionToken)).toEqual({
      ok: true,
      agent_id: a.agentId,
    });
  });

  it("unknown, session-type, missing, and expired secrets are invalid (not replay)", async () => {
    const dbPath = tempDbPath();
    const a = await registerAgent(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const unknown = await postRefresh(
        app.url,
        "deadbeef.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      );
      expect(unknown.status).toBe(401);
      expect(unknown.json["error"]).toBe("reconnect_secret_invalid");

      // A session token is rotation-only territory: rejected, not replay.
      const sessionAsReconnect = await postRefresh(app.url, a.sessionToken);
      expect(sessionAsReconnect.status).toBe(401);
      expect(sessionAsReconnect.json["error"]).toBe("reconnect_secret_invalid");

      const missing = await postRefresh(app.url, undefined);
      expect(missing.status).toBe(401);
      expect(missing.json["error"]).toBe("reconnect_secret_invalid");

      // Expire the reconnect row server-side: invalid, never replay.
      app
        .db!.prepare(
          "UPDATE credentials SET expires_at = '2000-01-01T00:00:00.000Z' WHERE type = 'agent_reconnect'",
        )
        .run();
      const expired = await postRefresh(app.url, a.reconnectSecret);
      expect(expired.status).toBe(401);
      expect(expired.json["error"]).toBe("reconnect_secret_invalid");
    } finally {
      await app.close();
    }
  });

  it("non-object bodies are rejected with 400", async () => {
    const dbPath = tempDbPath();
    const a = await registerAgent(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      // Unknown fields on an object are ignored: still rotates.
      const ok = await postRefresh(app.url, a.reconnectSecret, {
        unexpected: true,
      });
      expect(ok.status).toBe(200);
      // Bad bodies never reach rotation (each still consumes rate-limit
      // budget, so they run against the fresh secret: exactly 5).
      const fresh = ok.json["reconnect_secret"] as string;
      for (const bad of [NO_BODY, "oops", [1], 42, null]) {
        const res = await postRefresh(app.url, fresh, bad);
        expect(res.status).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it("two simultaneous refreshes cannot both succeed", async () => {
    const dbPath = tempDbPath();
    const a = await registerAgent(dbPath, "agent-a");
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      const [first, second] = await Promise.all([
        postRefresh(app.url, a.reconnectSecret),
        postRefresh(app.url, a.reconnectSecret),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = first.status === 200 ? second : first;
      expect(loser.json["error"]).toBe("reconnect_already_used");
      // The old credential is never silently restored by the loser.
      const retry = await postRefresh(app.url, a.reconnectSecret);
      expect(retry.status).toBe(401);
      expect(retry.json["error"]).toBe("reconnect_already_used");
    } finally {
      await app.close();
    }
  });

  it("per-credential budget enforced: 5 allowed, 6th is 429 with retry_after", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    try {
      const dead =
        "deadbeef.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
      for (let i = 0; i < 5; i++) {
        const res = await postRefresh(app.url, dead);
        expect(res.status).toBe(401);
      }
      const limited = await postRefresh(app.url, dead);
      expect(limited.status).toBe(429);
      expect(limited.json["error"]).toBe("rate_limit_exceeded");
      expect(limited.json["retry_after"]).toBe(60);
    } finally {
      await app.close();
    }
  });

  it("unit: refresh limiter budgets (5 per credential, 60 global)", () => {
    const limiter = new RefreshLimiter();
    for (let i = 0; i < 5; i++) expect(limiter.consume("cred-a")).toBe(true);
    expect(limiter.consume("cred-a")).toBe(false);
    expect(limiter.consume("cred-b")).toBe(true);

    const global = new RefreshLimiter();
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (global.consume(`cred-${i}`)) allowed += 1;
    }
    expect(allowed).toBe(60);
  });
});
