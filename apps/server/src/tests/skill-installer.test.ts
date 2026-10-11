import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { mintCredential } from "../identity/credentials.js";
import { listen } from "../http/server.js";
import { tempDbPath } from "./test-support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(HERE, "../../../../packages/skill/install.mjs");

function freshOtp(app: {
  db: import("../database/db.js").PolymerDatabase | null;
}): { id: string; secret: string } {
  const { credential, secret } = mintCredential(app.db!, { type: "init" });
  return { id: credential.credential_id, secret };
}

function install(
  app: { url: string },
  dir: string,
  extra: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  // Async spawn, never spawnSync: the server under test lives in this
  // process, and a synchronous wait would block its event loop while
  // the installer waits for MCP responses — a self-deadlock.
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [INSTALLER, "--server", app.url, "--dir", dir, ...extra],
      { timeout: 30000 },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({ status: status ?? 1, stdout, stderr }),
    );
  });
}

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "polymer-skill-"));
}

describe("skill installer (component 30)", () => {
  it("enrolls an agent into a clean repo: MCP config, .polymrc, gitignore", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-skill-"),
    });
    try {
      const dir = tempRepo();
      const otp = freshOtp(app);
      const first = await install(app, dir, [
        "--name",
        "skill-agent",
        "--role",
        "coder",
        "--init-token-id",
        otp.id,
        "--init-token",
        otp.secret,
      ]);
      expect(first.status).toBe(0);

      // `.polymrc` holds the credentials, locked down to owner-only.
      const rc = JSON.parse(
        readFileSync(join(dir, ".polymrc"), "utf8"),
      ) as Record<string, unknown>;
      expect(rc["server"]).toBe(app.url);
      expect(rc["agent_name"]).toBe("skill-agent");
      expect(typeof rc["agent_id"]).toBe("string");
      expect(typeof rc["session_token"]).toBe("string");
      expect(typeof rc["reconnect_secret"]).toBe("string");
      expect(rc["otel_endpoint"]).toBe(`${app.url}/otel`);
      expect(statSync(join(dir, ".polymrc")).mode & 0o777).toBe(0o600);

      // The enrolled credential really works over MCP.
      const client = new Client({ name: "verify", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
          requestInit: {
            headers: { Authorization: `Bearer ${rc["session_token"]}` },
          },
        }),
      );
      try {
        const ping = (await client.callTool({
          name: "ping",
          arguments: {},
        })) as { structuredContent: Record<string, unknown> };
        expect(ping.structuredContent["ok"]).toBe(true);
      } finally {
        await client.close();
      }

      // `.mcp.json` points at the server and carries no secrets.
      const mcp = JSON.parse(
        readFileSync(join(dir, ".mcp.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(JSON.stringify(mcp)).toContain(app.url);
      expect(JSON.stringify(mcp)).not.toContain(rc["session_token"] as string);
      expect(JSON.stringify(mcp)).not.toContain(
        rc["reconnect_secret"] as string,
      );

      // `.gitignore` covers `.polymrc` exactly once…
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(
        gitignore.split("\n").filter((l) => l.trim() === ".polymrc"),
      ).toHaveLength(1);
      // …and nothing printed carries secrets either.
      expect(first.stdout).not.toContain(rc["session_token"] as string);
      expect(first.stderr).not.toContain(rc["session_token"] as string);
      expect(first.stdout).toContain(rc["agent_id"] as string);

      // Second run without OTPs: idempotent, same agent, still single line.
      const second = await install(app, dir, ["--name", "skill-agent"]);
      expect(second.status).toBe(0);
      const rc2 = JSON.parse(
        readFileSync(join(dir, ".polymrc"), "utf8"),
      ) as Record<string, unknown>;
      expect(rc2["agent_id"]).toBe(rc["agent_id"]);
      const gitignore2 = readFileSync(join(dir, ".gitignore"), "utf8");
      expect(
        gitignore2.split("\n").filter((l) => l.trim() === ".polymrc"),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  }, 60000);

  it("bad OTPs fail without writing credentials; missing flags show usage", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-skill-"),
    });
    try {
      const dir = tempRepo();
      const bad = await install(app, dir, [
        "--name",
        "skill-agent",
        "--init-token-id",
        "no-such-credential",
        "--init-token",
        "wrong",
      ]);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain("registration failed");

      const usage = await install(app, tempRepo(), ["--name", "only-name"]);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain("usage:");
    } finally {
      await app.close();
    }
  }, 60000);

  it("the installer binary has no syntax errors", () => {
    execFileSync(process.execPath, ["--check", INSTALLER], { timeout: 15000 });
  });
});
