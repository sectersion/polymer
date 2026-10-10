// @vitest-environment jsdom
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { render, waitFor, screen } from "@testing-library/react";
import WS from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import React from "react";
import { useEvents } from "../lib/use-events";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIST = join(WEB_DIR, "..", "server", "dist", "index.js");

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
let adminCookie = "";
let agentToken = "";

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

function Probe({
  apiUrl,
  seen,
}: {
  apiUrl: string;
  seen: string[];
}): React.JSX.Element {
  const status = useEvents(
    (type) => {
      seen.push(type);
    },
    () => {},
    { apiUrl, pollMs: 60000 },
  );
  return (
    <p data-testid="events-probe" data-status={status}>
      {seen.join(",")}
    </p>
  );
}

describe("useEvents hook (component 21)", () => {
  beforeAll(async () => {
    const backendPort = await freePort();
    const webPort = await freePort();
    BACKEND_URL = `http://127.0.0.1:${backendPort}`;
    WEB_URL = `http://127.0.0.1:${webPort}`;
    const dir = mkdtempSync(join(tmpdir(), "polymer-events-ui-"));
    const dbPath = join(dir, "events.db");
    backend = spawn("node", [SERVER_DIST], {
      env: {
        ...process.env,
        POLYMER_PORT: String(backendPort),
        POLYMER_DATABASE_PATH: dbPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const master = await waitForOutput(
      backend,
      /master credential[^:]*: ([0-9a-f]+)/,
      30000,
    );
    await waitForOutput(backend, /ready on/, 30000);

    // jsdom has no cookie jar shared with undici fetch, and the
    // hook builds a bare `new WebSocket(url)`: stub both transports
    // the way a same-origin browser would carry them (session cookie
    // automatic). The hook code under test is untouched.
    const loginRes = await fetch(`${BACKEND_URL}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ master_credential: master }),
    });
    expect(loginRes.status).toBe(200);
    adminCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      (url: string | URL | Request, init?: RequestInit) => {
        const text = String(url);
        if (text === "/api/auth/csrf") {
          return realFetch(`${WEB_URL}/api/auth/csrf`, {
            ...init,
            headers: { ...(init?.headers as object), cookie: adminCookie },
          });
        }
        return realFetch(url as string, init);
      },
    );
    class CookieWebSocket extends WS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url as string, protocols as string[], {
          headers: { cookie: adminCookie },
        });
      }
    }
    vi.stubGlobal("WebSocket", CookieWebSocket);

    // Boot the production web build (for the /api/auth/csrf route).
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
      build.stderr?.on("data", (c: Buffer) => {
        out += c.toString();
      });
      build.stdout?.on("data", (c: Buffer) => {
        out += c.toString();
      });
    });
    web = spawn(
      "node",
      ["node_modules/next/dist/bin/next", "start", "-p", String(webPort)],
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

    // Seed one agent over real MCP for the mutations below (init
    // token minted through the admin REST surface after login).
    const client = new Client({ name: "seed", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BACKEND_URL}/mcp`)),
    );
    try {
      const webCsrf = (await (
        await fetch(`${WEB_URL}/api/auth/csrf`, {
          headers: { cookie: adminCookie },
        })
      ).json()) as { csrf_token: string };
      const mintRes = await fetch(`${BACKEND_URL}/api/tokens/init`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: adminCookie,
          "x-csrf-token": webCsrf.csrf_token,
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
          name: "events-agent",
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      agentToken = reg.structuredContent["session_token"] as string;
    } finally {
      await client.close();
    }
  }, 300000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    backend?.kill("SIGTERM");
    web?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1000));
  });

  it(
    "a WS push from an MCP mutation reaches the hook without any navigation",
    { timeout: 60000 },
    async () => {
      const seen: string[] = [];
      const { unmount } = render(
        React.createElement(Probe, { apiUrl: BACKEND_URL, seen }),
      );
      try {
        // The hook reports a live socket…
        await waitFor(
          () => {
            expect(
              screen.getByTestId("events-probe").getAttribute("data-status"),
            ).toBe("live");
          },
          { timeout: 15000 },
        );
        // …then an MCP mutation pushes through it with no reload.
        const client = new Client({ name: "mutator", version: "0.0.0" });
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
            arguments: { title: "Pushed task" },
          });
        } finally {
          await client.close();
        }
        await waitFor(
          () => {
            expect(seen).toContain("task.created");
          },
          { timeout: 15000 },
        );
      } finally {
        unmount();
      }
    },
  );
});
