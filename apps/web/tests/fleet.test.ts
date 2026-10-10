import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIST = join(WEB_DIR, "..", "server", "dist", "index.js");

/** An ephemeral loopback port, so parallel/leftover runs never collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("no port assigned"));
        }
      });
    });
  });
}

let BACKEND_URL = "";
let WEB_URL = "";

let backend: ChildProcess | undefined;
let web: ChildProcess | undefined;

function waitForOutput(
  proc: ChildProcess,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  let seen = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${pattern}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString();
      const match = pattern.exec(seen);
      if (match !== null) {
        clearTimeout(timer);
        proc.stderr?.off("data", onData);
        proc.stdout?.off("data", onData);
        resolve(match[1] ?? match[0]);
      }
    };
    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);
  });
}

describe("Fleet page (component 20)", () => {
  let adminCookie = "";
  let agentToken = "";

  beforeAll(async () => {
    const backendPort = await freePort();
    const webPort = await freePort();
    BACKEND_URL = `http://127.0.0.1:${backendPort}`;
    WEB_URL = `http://127.0.0.1:${webPort}`;
    const dir = mkdtempSync(join(tmpdir(), "polymer-web-"));
    const dbPath = join(dir, "fleet.db");
    backend = spawn("node", [SERVER_DIST], {
      env: {
        ...process.env,
        POLYMER_PORT: String(backendPort),
        POLYMER_DATABASE_PATH: dbPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // First boot prints the master credential once on stderr.
    const master = await waitForOutput(
      backend,
      /master credential[^:]*: ([0-9a-f]+)/,
      30000,
    );
    await waitForOutput(backend, /ready on/, 30000);

    // Seed fleet state through real MCP: register + create + claim.
    const client = new Client({ name: "seed", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BACKEND_URL}/mcp`)),
    );
    try {
      // Admin-mint an init token over REST after login.
      const loginRes = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ master_credential: master }),
      });
      expect(loginRes.status).toBe(200);
      const setCookie = loginRes.headers.get("set-cookie") ?? "";
      adminCookie = setCookie.split(";")[0];
      const { csrf_token } = (await loginRes.json()) as {
        csrf_token: string;
      };
      const mintRes = await fetch(`${BACKEND_URL}/api/tokens/init`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "x-csrf-token": csrf_token,
        },
        body: JSON.stringify({}),
      });
      expect(mintRes.status).toBe(200);
      const { init_token_id, init_token } = (await mintRes.json()) as {
        init_token_id: string;
        init_token: string;
      };
      const reg = (await client.callTool({
        name: "register_agent",
        arguments: {
          init_token_id,
          init_token,
          name: "seed-agent",
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      const sessionToken = reg.structuredContent["session_token"] as string;
      agentToken = sessionToken;
      const authed = new Client({ name: "seed-authed", version: "0.0.0" });
      await authed.connect(
        new StreamableHTTPClientTransport(new URL(`${BACKEND_URL}/mcp`), {
          requestInit: {
            headers: { Authorization: `Bearer ${sessionToken}` },
          },
        }),
      );
      try {
        const created = (await authed.callTool({
          name: "create_task",
          arguments: { title: "Seeded task" },
        })) as { structuredContent: Record<string, unknown> };
        await authed.callTool({
          name: "claim_task",
          arguments: { task_id: created.structuredContent["task_id"] },
        });
      } finally {
        await authed.close();
      }
    } finally {
      await client.close();
    }

    // Boot the production web build against this backend. The
    // build runs here (not just `next start` on a stale .next) so the
    // test is hermetic: what it fetches is current sources.
    const build = spawn("node", ["node_modules/next/dist/bin/next", "build"], {
      cwd: WEB_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error(`next build timed out: ${out.slice(-500)}`)),
        300000,
      );
      build.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`next build exited ${code}: ${out.slice(-500)}`));
      });
      build.stderr?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
      build.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
      });
    });
    web = spawn(
      "node",
      [
        join(WEB_DIR, "node_modules", "next", "dist", "bin", "next"),
        "start",
        "-p",
        String(webPort),
      ],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          POLYMER_API_URL: BACKEND_URL,
          PORT: String(webPort),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await waitForOutput(web, /Ready in|started server/i, 60000);
  }, 300000);

  afterAll(async () => {
    backend?.kill("SIGTERM");
    web?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
  });

  it("renders live MCP-created fleet state", { timeout: 60000 }, async () => {
    const res = await fetch(`${WEB_URL}/`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Fleet");
    expect(html).toContain("Agents");
    expect(html).toContain("Tasks");
    expect(html).toContain("Active");
    // One agent, one task, one active (claimed) task.
    const counts = [...html.matchAll(/tabular-nums">(\d+)</g)].map((m) => m[1]);
    expect(counts).toEqual(["1", "1", "1"]);
    // The live-region hook is wired: pushes and poll refreshes call
    // router.refresh(), so the next navigation shows fresh state.
    expect(html).toContain('data-testid="fleet-live"');
  });

  it(
    "shows newly created tasks on refetch without a manual reload",
    { timeout: 60000 },
    async () => {
      const client = new Client({ name: "seed-late", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${BACKEND_URL}/mcp`), {
          requestInit: {
            headers: { Authorization: `Bearer ${agentToken}` },
          },
        }),
      );
      try {
        await client.callTool({
          name: "create_task",
          arguments: { title: "Late task" },
        });
      } finally {
        await client.close();
      }
      // No browser refresh involved: a fresh navigation (what the poll
      // fallback and push-driven router.refresh() both produce) shows
      // the new task immediately.
      const res = await fetch(`${WEB_URL}/`, {
        headers: { cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      const counts = [...html.matchAll(/tabular-nums">(\d+)</g)].map(
        (m) => m[1],
      );
      expect(counts).toEqual(["1", "2", "1"]);
    },
  );

  it(
    "redirects unauthenticated visitors to Login, which renders",
    { timeout: 60000 },
    async () => {
      const res = await fetch(`${WEB_URL}/`, { redirect: "manual" });
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
      const login = await fetch(`${WEB_URL}/login`);
      expect(login.status).toBe(200);
      expect(await login.text()).toContain("master credential");
    },
  );
});
