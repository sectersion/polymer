import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import { mintCredential } from "./credentials.js";
import { getAgentById } from "./agents.js";
import { InitVerifyLimiter } from "./rate-limit.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-reg-")), "test.db");
}

function anonTransport(url: string) {
  return new StreamableHTTPClientTransport(new URL(`${url}${MCP_PATH}`));
}

function authedTransport(url: string, token: string) {
  return new StreamableHTTPClientTransport(new URL(`${url}${MCP_PATH}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function anonClient(url: string): Promise<Client> {
  const client = new Client({ name: "new-agent", version: "0.0.0" });
  await client.connect(anonTransport(url));
  return client;
}

async function callRegister(
  client: Client,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "register_agent",
    arguments: args,
  });
  return (result as { structuredContent: Record<string, unknown> })
    .structuredContent;
}

async function callRegisterError(
  client: Client,
  args: Record<string, unknown>,
): Promise<string> {
  // Tool failures resolve with isError:true (not a thrown transport error).
  const result = (await client.callTool({
    name: "register_agent",
    arguments: args,
  })) as { isError?: boolean };
  expect(result.isError).toBe(true);
  return JSON.stringify(result);
}

async function callToolError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
  };
  expect(result.isError).toBe(true);
  return JSON.stringify(result);
}

describe("Agent registration (component 7)", () => {
  it("new agent bootstraps over real MCP; plaintext never persisted", async () => {
    // Each client gets its own server, all sharing one SQLite file
    // (the fleet view); servers accept many sessions now (mcp.test.ts).
    const dbPath = tempDbPath();
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const client = await anonClient(app.url);
    let out: Record<string, unknown>;
    try {
      const { credential, secret } = mintCredential(app.db!, {
        type: "init",
      });
      out = await callRegister(client, {
        init_token_id: credential.credential_id,
        init_token: secret,
        name: "alpha",
        role: "coder",
      });
      expect(out["agent_id"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof out["session_token"]).toBe("string");
      expect(typeof out["reconnect_secret"]).toBe("string");
      expect(out["expires_in"]).toBe(604800);
      expect(out["reconnect_expires_in"]).toBe(2592000);

      const dump = JSON.stringify(
        app.db!.prepare("SELECT * FROM credentials").all(),
      );
      expect(dump).not.toContain(out["session_token"]);
      expect(dump).not.toContain(out["reconnect_secret"]);
      expect(dump).not.toContain(secret);
    } finally {
      await client.close();
      await app.close();
    }

    // Session token authenticates follow-up calls as the new agent.
    const app2 = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const authed = new Client({ name: "alpha", version: "0.0.0" });
    await authed.connect(
      authedTransport(app2.url, out!["session_token"] as string),
    );
    try {
      const ping = await authed.callTool({ name: "ping", arguments: {} });
      expect(
        (ping as { structuredContent?: unknown }).structuredContent,
      ).toEqual({ ok: true, agent_id: out!["agent_id"] });
    } finally {
      await authed.close();
      await app2.close();
    }
  });

  it("init token cannot be reused; expired rejected; wrong guess does not consume", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    const client = await anonClient(app.url);
    try {
      const first = mintCredential(app.db!, { type: "init" });
      await callRegister(client, {
        init_token_id: first.credential.credential_id,
        init_token: first.secret,
        name: "alpha",
        role: "coder",
      });
      const second = mintCredential(app.db!, { type: "init" });
      expect(
        await callRegisterError(client, {
          init_token_id: first.credential.credential_id,
          init_token: first.secret,
          name: "beta",
          role: "coder",
        }),
      ).toContain("token_already_used");
      void second;

      const expired = mintCredential(app.db!, {
        type: "init",
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      expect(
        await callRegisterError(client, {
          init_token_id: expired.credential.credential_id,
          init_token: expired.secret,
          name: "gamma",
          role: "coder",
        }),
      ).toContain("token_expired");

      const fresh = mintCredential(app.db!, {
        type: "init",
        secret: "123456",
      });
      expect(
        await callRegisterError(client, {
          init_token_id: fresh.credential.credential_id,
          init_token: "000000",
          name: "delta",
          role: "coder",
        }),
      ).toContain("invalid_token");
      const out = await callRegister(client, {
        init_token_id: fresh.credential.credential_id,
        init_token: "123456",
        name: "delta",
        role: "coder",
      });
      expect(out["agent_id"]).toBeDefined();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("global OTP cap is atomic, not per-key: 600 IPs share 60 units", () => {
    const limiter = new InitVerifyLimiter();
    let allowed = 0;
    for (let i = 0; i < 600; i++) {
      if (limiter.consume(`10.0.0.${i % 250}.${(i / 250) | 0}`)) allowed += 1;
    }
    expect(allowed).toBe(60);
  });

  it("per-IP budget enforced over real HTTP before any lookup", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    try {
      for (let i = 0; i < 10; i++) {
        const res = await fetch(`${app.url}${MCP_PATH}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: i,
            method: "tools/call",
            params: {
              name: "register_agent",
              arguments: {
                init_token_id: "00000000-0000-4000-8000-000000000000",
                init_token: "000000",
                name: "x",
                role: "coder",
              },
            },
          }),
        });
        expect(res.status).not.toBe(429);
        await res.body?.cancel();
      }
      const limited = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: {
            name: "register_agent",
            arguments: {
              init_token_id: "00000000-0000-4000-8000-000000000000",
              init_token: "000000",
              name: "x",
              role: "coder",
            },
          },
        }),
      });
      expect(limited.status).toBe(429);
      const body = (await limited.json()) as {
        error?: string;
        retry_after?: number;
      };
      expect(body.error).toBe("rate_limit_exceeded");
      expect(body.retry_after).toBe(60);
    } finally {
      await app.close();
    }
  });

  it("reconnect credential authenticates nothing except refresh", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    const client = await anonClient(app.url);
    try {
      const init = mintCredential(app.db!, { type: "init" });
      const out = await callRegister(client, {
        init_token_id: init.credential.credential_id,
        init_token: init.secret,
        name: "alpha",
        role: "coder",
      });
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${out["reconnect_secret"]}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      await res.body?.cancel();
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("subagent spawns with caller as parent; names unique; no spoofing", async () => {
    const dbPath = tempDbPath();
    const app = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const client = await anonClient(app.url);
    let parent: Record<string, unknown>;
    try {
      const init = mintCredential(app.db!, { type: "init" });
      parent = await callRegister(client, {
        init_token_id: init.credential.credential_id,
        init_token: init.secret,
        name: "orchestrator",
        role: "orchestrator",
      });
    } finally {
      await client.close();
      await app.close();
    }

    const appA = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const agentA = new Client({ name: "orchestrator", version: "0.0.0" });
    await agentA.connect(
      authedTransport(appA.url, parent!["session_token"] as string),
    );
    let childSession: string;
    let childId: string;
    try {
      const child = (await agentA.callTool({
        name: "register_subagent",
        arguments: { name: "worker", role: "coder" },
      })) as { structuredContent: Record<string, unknown> };
      const structured = child.structuredContent;
      expect(structured["parent_agent_id"]).toBe(parent!["agent_id"]);
      childSession = structured["session_token"] as string;
      childId = structured["agent_id"] as string;

      expect(
        await callToolError(agentA, "register_subagent", {
          name: "worker",
          role: "coder",
        }),
      ).toContain("name_taken");
    } finally {
      await agentA.close();
      await appA.close();
    }

    // Child authenticates as itself; parent link persisted server-side.
    const appB = await listen("127.0.0.1", 0, { databasePath: dbPath });
    try {
      expect(getAgentById(appB.db!, childId!)).toMatchObject({
        parent_agent_id: parent!["agent_id"],
      });
      const worker = new Client({ name: "worker", version: "0.0.0" });
      await worker.connect(authedTransport(appB.url, childSession!));
      try {
        const ping = await worker.callTool({ name: "ping", arguments: {} });
        expect(
          (ping as { structuredContent?: unknown }).structuredContent,
        ).toEqual({ ok: true, agent_id: childId! });
      } finally {
        await worker.close();
      }
    } finally {
      await appB.close();
    }

    // A session token cannot call register_agent.
    const appC = await listen("127.0.0.1", 0, { databasePath: dbPath });
    const authed = new Client({ name: "orchestrator", version: "0.0.0" });
    await authed.connect(
      authedTransport(appC.url, parent!["session_token"] as string),
    );
    try {
      expect(
        await callToolError(authed, "register_agent", {
          init_token_id: "00000000-0000-4000-8000-000000000000",
          init_token: "000000",
          name: "intruder",
          role: "coder",
        }),
      ).toContain("unauthorized");
    } finally {
      await authed.close();
      await appC.close();
    }
  });

  it("init token cannot call register_subagent", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath(),
    });
    try {
      const init = mintCredential(app.db!, { type: "init" });
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${init.secret}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "register_subagent",
            arguments: { name: "x", role: "coder" },
          },
        }),
      });
      expect(res.status).toBe(401);
      await res.body?.cancel();
    } finally {
      await app.close();
    }
  });
});
