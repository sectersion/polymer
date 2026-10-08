import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { mintCredential } from "../identity/credentials.js";
import { listen } from "../http/server.js";

export type App = Awaited<ReturnType<typeof listen>>;

export interface AgentSession {
  agentId: string;
  token: string;
}

export function tempDbPath(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), prefix)), "test.db");
}

/** Register agents over real MCP (the unauthenticated bootstrap surface). */
export async function registerAgentsOn(
  app: App,
  names: string[],
): Promise<AgentSession[]> {
  const bootstrap = new Client({ name: "bootstrap", version: "0.0.0" });
  await bootstrap.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  try {
    const sessions: AgentSession[] = [];
    for (const name of names) {
      const { credential, secret } = mintCredential(app.db!, {
        type: "init",
      });
      const reg = (await bootstrap.callTool({
        name: "register_agent",
        arguments: {
          init_token_id: credential.credential_id,
          init_token: secret,
          name,
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      sessions.push({
        agentId: reg.structuredContent["agent_id"] as string,
        token: reg.structuredContent["session_token"] as string,
      });
    }
    return sessions;
  } finally {
    await bootstrap.close();
  }
}

/** Attach real MCP clients (own sessions) to an already-listening app. */
export async function withAuthedClients<T>(
  app: App,
  tokens: string[],
  fn: (clients: Client[]) => Promise<T>,
): Promise<T> {
  const clients: Client[] = [];
  for (const token of tokens) {
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
  }
  try {
    return await fn(clients);
  } finally {
    for (const client of clients) {
      await client.close();
    }
  }
}

/** Lapse the lazy-expiry lease (time has simply passed for it). */
export function lapseLeases(app: App): void {
  app
    .db!.prepare(
      "UPDATE tasks SET lease_expires_at = '2000-01-01T00:00:00.000Z'",
    )
    .run();
}
