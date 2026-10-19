import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { tempDbPath } from "./test-support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(HERE, "../../../../packages/skill");
const SETUP = join(SKILL_DIR, "setup.mjs");

function runSetup(
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SETUP, ...args], { timeout: 90000 });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) =>
      resolvePromise({ status: status ?? 1, stdout, stderr }),
    );
  });
}

async function freePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolvePromise, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolvePromise(address.port);
        } else {
          reject(new Error("no port assigned"));
        }
      });
    });
  });
}

describe("polymer-setup one-command bootstrap", () => {
  it("creates a --dir that does not exist instead of crashing (audit #28)", async () => {
    const base = mkdtempSync(join(tmpdir(), "polymer-setup-"));
    const dir = join(base, "nested", "fresh-agent");
    const port = await freePort();
    const db = tempDbPath("polymer-setup-dir-");
    const run = await runSetup([
      "--name",
      "setup-dir-agent",
      "--dir",
      dir,
      "--db",
      db,
      "--port",
      String(port),
    ]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)["ok"]).toBe(true);
    expect(readFileSync(join(dir, ".polymrc"), "utf8")).toContain("server");
  }, 90000);

  it("boots a daemon, enrolls, verifies; reruns reuse; stop kills", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polymer-setup-"));
    const port = await freePort();
    const db = tempDbPath("polymer-setup-");
    const first = await runSetup([
      "--name",
      "setup-agent",
      "--dir",
      dir,
      "--db",
      db,
      "--port",
      String(port),
    ]);
    expect(first.status).toBe(0);
    const summary = JSON.parse(first.stdout) as Record<string, unknown>;
    expect(summary["ok"]).toBe(true);
    expect(summary["server"]).toBe(`http://127.0.0.1:${port}`);
    expect(typeof summary["agent_id"]).toBe("string");
    // Nothing printed carries secrets.
    expect(first.stdout).not.toContain("master credential");
    const rc = JSON.parse(
      readFileSync(join(dir, ".polymrc"), "utf8"),
    ) as Record<string, unknown>;
    expect(first.stdout).not.toContain(rc["session_token"] as string);

    // The daemon answers and the credential really works over MCP.
    const client = new Client({ name: "verify", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`${summary["server"]}${MCP_PATH}`),
        {
          requestInit: {
            headers: { Authorization: `Bearer ${rc["session_token"]}` },
          },
        },
      ),
    );
    try {
      const ping = (await client.callTool({ name: "ping", arguments: {} })) as {
        structuredContent: Record<string, unknown>;
      };
      expect(ping.structuredContent["ok"]).toBe(true);
    } finally {
      await client.close();
    }

    // Rerun: same daemon reused, same agent, no duplicate enrollment.
    const second = await runSetup(["--name", "setup-agent", "--dir", dir]);
    expect(second.status).toBe(0);
    expect(
      (JSON.parse(second.stdout) as Record<string, unknown>)["agent_id"],
    ).toBe(summary["agent_id"]);
    const status = await runSetup(["--status", "--dir", dir]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      running: true,
      healthy: true,
    });

    // Stop kills the daemon; status reports down afterwards.
    const stop = await runSetup(["--stop", "--dir", dir]);
    expect(stop.status).toBe(0);
    const down = await runSetup(["--status", "--dir", dir]);
    expect(JSON.parse(down.stdout)).toMatchObject({ running: false });
  }, 120000);

  it("fails cleanly with no built server", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polymer-setup-"));
    const missing = await runSetup([
      "--name",
      "ghost",
      "--dir",
      dir,
      "--server-entry",
      join(dir, "does-not-exist.js"),
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("server entry not found");
  }, 60000);
});
