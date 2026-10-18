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

describe("Telemetry page (loose-end C)", () => {
  let adminCookie = "";

  beforeAll(async () => {
    const backendPort = await freePort();
    const webPort = await freePort();
    BACKEND_URL = `http://127.0.0.1:${backendPort}`;
    WEB_URL = `http://127.0.0.1:${webPort}`;
    const dir = mkdtempSync(join(tmpdir(), "polymer-web-"));
    const dbPath = join(dir, "telemetry.db");
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

    const client = new Client({ name: "seed", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BACKEND_URL}/mcp`)),
    );
    let sessionToken = "";
    try {
      const loginRes = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ master_credential: master }),
      });
      expect(loginRes.status).toBe(200);
      adminCookie = (loginRes.headers.get("set-cookie") ?? "").split(";")[0];
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
          name: "telemetry-agent",
          role: "coder",
        },
      })) as { structuredContent: Record<string, unknown> };
      sessionToken = reg.structuredContent["session_token"] as string;
    } finally {
      await client.close();
    }

    // Real OTLP intake behind the page: known model, tokens, cost.
    const otlp = await fetch(`${BACKEND_URL}/otel/v1/traces`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    traceId: "9".repeat(32),
                    spanId: "8".repeat(16),
                    name: "seeded",
                    attributes: [
                      {
                        key: "gen_ai.request.model",
                        value: { stringValue: "seed-model" },
                      },
                      {
                        key: "gen_ai.usage.input_tokens",
                        value: { intValue: "100" },
                      },
                      {
                        key: "gen_ai.usage.output_tokens",
                        value: { intValue: "50" },
                      },
                      {
                        key: "gen_ai.usage.cost_micro_usd",
                        value: { intValue: "2500" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(otlp.status).toBe(200);

    // 200 means enqueued, not committed: wait for the flush to land
    // the usage row before asserting on the rendered page. (The old
    // per-file builds accidentally provided this settling time.)
    const deadline = Date.now() + 15000;
    for (;;) {
      const summary = (await (
        await fetch(`${BACKEND_URL}/api/telemetry/summary`, {
          headers: { cookie: adminCookie },
        })
      ).json()) as Record<string, number>;
      if (summary["total_tokens_used"] === 150) break;
      if (Date.now() > deadline) {
        throw new Error("telemetry never flushed before page fetch");
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    // Boot the shared production build (built once per run by
    // tests/setup-build.ts) against this backend.
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

  it(
    "renders stored telemetry: KPIs, agent row, model, costs",
    { timeout: 60000 },
    async () => {
      const res = await fetch(`${WEB_URL}/telemetry`, {
        headers: { cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Telemetry");
      expect(html).toContain("telemetry-agent");
      expect(html).toContain("seed-model");
      // Exact stored figures surface unrounded.
      expect(html).toContain("2,500");
      expect(html).toContain("150");
      expect(html).toContain("Cost per day");
    },
  );

  it(
    "fleet cards now include tokens and cost",
    { timeout: 60000 },
    async () => {
      const res = await fetch(`${WEB_URL}/`, {
        headers: { cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Tokens");
      // Cost card shows formatted dollars; the raw µUSD lives in the tooltip.
      expect(html).toContain(">Cost<");
      expect(html).toContain("µUSD");
    },
  );
});
