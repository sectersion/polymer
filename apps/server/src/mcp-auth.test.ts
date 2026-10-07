import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "./mcp.js";
import { listen } from "./server.js";
import {
  clearTestCredentials,
  mintTestCredential,
  extractBearerToken,
  verifyTestCredential,
} from "./auth.js";

function authedTransport(url: string, token: string) {
  return new StreamableHTTPClientTransport(new URL(`${url}${MCP_PATH}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
}

async function connect(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(authedTransport(url, token));
  return client;
}

beforeEach(() => {
  clearTestCredentials();
});

describe("MCP authentication middleware (component 3)", () => {
  it("valid credential -> ping succeeds with caller identity", async () => {
    const { token } = mintTestCredential("agent-a");
    const app = await listen("127.0.0.1", 0);
    const client = await connect(app.url, token);
    try {
      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(
        (result as { structuredContent?: unknown }).structuredContent,
      ).toEqual({ ok: true, agent_id: "agent-a" });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("missing credential -> rejected with 401", async () => {
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("unauthorized");
    } finally {
      await app.close();
    }
  });

  it("invalid credential -> rejected", async () => {
    mintTestCredential("agent-a");
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer poly_test_wrong",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("expired credential -> rejected", async () => {
    const { token } = mintTestCredential("agent-expired", -1_000);
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "ping", arguments: {} },
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason?: string };
      expect(body.reason).toBe("expired");
    } finally {
      await app.close();
    }
  });

  it("each agent receives its own identity", async () => {
    const a = mintTestCredential("agent-a");
    const b = mintTestCredential("agent-b");
    const appA = await listen("127.0.0.1", 0);
    const appB = await listen("127.0.0.1", 0);
    const clientA = await connect(appA.url, a.token);
    const clientB = await connect(appB.url, b.token);
    try {
      const ra = await clientA.callTool({ name: "ping", arguments: {} });
      const rb = await clientB.callTool({ name: "ping", arguments: {} });
      expect(
        (ra as { structuredContent?: unknown }).structuredContent,
      ).toEqual({ ok: true, agent_id: "agent-a" });
      expect(
        (rb as { structuredContent?: unknown }).structuredContent,
      ).toEqual({ ok: true, agent_id: "agent-b" });
    } finally {
      await clientA.close();
      await clientB.close();
      await appA.close();
      await appB.close();
    }
  });

  it("supplying another agent_id cannot impersonate", async () => {
    const a = mintTestCredential("agent-a");
    mintTestCredential("agent-b");
    const app = await listen("127.0.0.1", 0);
    const client = await connect(app.url, a.token);
    try {
      const result = await client.callTool({
        name: "ping",
        arguments: { agent_id: "agent-b" },
      });
      expect(
        (result as { structuredContent?: unknown }).structuredContent,
      ).toEqual({ ok: true, agent_id: "agent-a" });
    } finally {
      await client.close();
      await app.close();
    }
  });

  it("unit: extractor + verifier matrix (no secrets logged)", async () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(verifyTestCredential(undefined)).toEqual({
      ok: false,
      reason: "missing",
    });
    const { token } = mintTestCredential("agent-u");
    const ok = verifyTestCredential(token);
    expect(ok.ok).toBe(true);
  });

  it("unauthenticated GET and DELETE on /mcp are rejected", async () => {
    const app = await listen("127.0.0.1", 0);
    try {
      const get = await fetch(`${app.url}${MCP_PATH}`, { method: "GET" });
      expect(get.status).toBe(401);
      await get.body?.cancel();
      const del = await fetch(`${app.url}${MCP_PATH}`, { method: "DELETE" });
      expect(del.status).toBe(401);
      await del.body?.cancel();
    } finally {
      await app.close();
    }
  });

  it("malformed Authorization shapes are rejected as missing", async () => {
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("Bearer   ")).toBeUndefined();
    expect(extractBearerToken(["Bearer abc", "Bearer def"])).toBe("abc");
    const app = await listen("127.0.0.1", 0);
    try {
      const res = await fetch(`${app.url}${MCP_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Basic abc123",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { reason?: string };
      expect(body.reason).toBe("missing");
    } finally {
      await app.close();
    }
  });
});
