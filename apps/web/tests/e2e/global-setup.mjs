import { cpSync, existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(HERE, "../..");
const REPO = resolve(WEB_DIR, "../..");
const SERVER_ENTRY = join(REPO, "apps/server/dist/index.js");
const INSTALLER = join(REPO, "packages/skill/install.mjs");
const STANDALONE_ENTRY = join(WEB_DIR, ".next/standalone/apps/web/server.js");
const STANDALONE_STATIC_FROM = join(WEB_DIR, ".next/static");
const STANDALONE_STATIC_TO = join(
  WEB_DIR,
  ".next/standalone/apps/web/.next/static",
);

let step = "setup";
function fail(message) {
  throw new Error(`web:e2e [FAIL] ${step}: ${message}`);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolvePort(port));
    });
  });
}

function killChild(child) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      done();
      return;
    }
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }, 5000).unref();
  });
}

/**
 * Diagnostics for a boot that never went healthy: a masked stderr
 * tail (the first-run master credential is replaced before printing —
 * secrets never reach test output, even for a throwaway DB so a
 * recognized credential string never lands in CI logs).
 */
function maskSecret(text) {
  return text.replace(
    /polymer master credential \(save it now; it is not shown again\): (\S+)/,
    "polymer master credential: ***masked***",
  );
}
function stderrTail(context, text) {
  console.error(
    `web:e2e ${context} stderr tail: ${maskSecret(text).slice(-2000)}`,
  );
}
async function waitUntilReady(check, what, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const ok = await check();
    if (ok) return;
    if (Date.now() > deadline) fail(`${what} never became ready`);
    await sleep(200);
  }
}

/**
 * Global setup for the admin-console browser smoke: boots a throwaway
 * production server (dist build) on a temporary database, seeds one
 * enrolled agent (via the real installer + MCP), seeds a task (MCP
 * `create_task`, the real onboarding flow's outcome), and boots the
 * built Next console against that server. No mocks on any transport
 * boundary; teardown kills both processes.
 */
export default async function globalSetup() {
  step = "prerequisites";
  if (!existsSync(SERVER_ENTRY)) fail("server not built — run pnpm build");
  if (!existsSync(STANDALONE_ENTRY)) fail("console not built — run pnpm build");
  if (!existsSync(STANDALONE_STATIC_TO)) {
    // The standalone output omits static assets by design; the Docker
    // image copies them in. Mirror that here (same layout the runtime
    // image uses) so hydration and client routing work in the browser.
    cpSync(STANDALONE_STATIC_FROM, STANDALONE_STATIC_TO, { recursive: true });
  }

  const workdir = mkdtempSync(join(tmpdir(), "polymer-web-e2e-"));
  const dbPath = join(workdir, "e2e.db");
  const apiPort = await freePort();
  const webPort = await freePort();
  const base = `http://127.0.0.1:${apiPort}`;
  const consoleUrl = `http://127.0.0.1:${webPort}`;

  step = "boot-server";
  const server = spawn(
    process.execPath,
    [SERVER_ENTRY, "--port", String(apiPort)],
    {
      env: { ...process.env, POLYMER_DATABASE_PATH: dbPath },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let master = null;
  let stderr = "";
  server.stderr.setEncoding("utf8");
  server.stderr.on("data", (chunk) => {
    stderr += chunk;
    const match = stderr.match(
      /polymer master credential \(save it now; it is not shown again\): (\S+)/,
    );
    if (match) master = match[1];
  });
  await waitUntilReady(
    async () => {
      try {
        return (await fetch(`${base}/health`)).status === 200;
      } catch {
        return false;
      }
    },
    "server",
    15000,
  );
  if (!master) {
    stderrTail("server", stderr);
    fail("first-run master credential never appeared on stderr");
  }

  step = "boot-console";
  const web = spawn(process.execPath, [STANDALONE_ENTRY], {
    env: {
      ...process.env,
      PORT: String(webPort),
      HOSTNAME: "127.0.0.1",
      POLYMER_API_URL: base,
      NODE_ENV: "production",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let webStderr = "";
  web.stderr.setEncoding("utf8");
  web.stderr.on("data", (chunk) => (webStderr += chunk));
  try {
    await waitUntilReady(
      async () => {
        try {
          return (await fetch(`${consoleUrl}/login`)).status === 200;
        } catch {
          return false;
        }
      },
      "console",
      60000,
    );

    step = "seed-agent";
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ master_credential: master }),
    });
    if (loginRes.status !== 200) fail("seed admin login failed");
    const login = await loginRes.json();
    const cookie = loginRes.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const otpRes = await fetch(`${base}/api/tokens/init`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": login.csrf_token,
        "content-type": "application/json",
      },
      body: "{}",
    });
    if (otpRes.status !== 200) fail("seed OTP mint failed");
    const otp = await otpRes.json();
    const agentDir = join(workdir, "smoke-agent");
    try {
      execFileSync(
        process.execPath,
        [
          INSTALLER,
          "--server",
          base,
          "--dir",
          agentDir,
          "--name",
          "smoke-agent",
          "--init-token-id",
          otp.init_token_id,
          "--init-token",
          otp.init_token,
        ],
        { timeout: 60000, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (err) {
      fail(`polymer-install seeded agent failed: ${err.message}`);
    }
    const rc = JSON.parse(readFileSync(join(agentDir, ".polymrc"), "utf8"));
    step = "seed-task";
    const { Client } =
      await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } =
      await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "web-e2e", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: {
          headers: { Authorization: `Bearer ${rc.session_token}` },
        },
      }),
    );
    await client.callTool({
      name: "create_task",
      arguments: { title: "playwright smoke task" },
    });
    await client.callTool({ name: "send_heartbeat", arguments: {} });
    await client.close().catch(() => {});

    // Export state for the spec.
    process.env.WEB_E2E_CONSOLE_URL = consoleUrl;
    process.env.WEB_E2E_MASTER_CREDENTIAL = master;
    process.env.WEB_E2E_WORKDIR = workdir;

    return async function teardown() {
      await killChild(server);
      await killChild(web);
    };
  } catch (err) {
    stderrTail("server", stderr);
    stderrTail("console", webStderr);
    await killChild(server);
    await killChild(web);
    throw err;
  }
}
