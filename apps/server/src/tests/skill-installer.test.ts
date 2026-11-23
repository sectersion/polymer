import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_PATH } from "../mcp/index.js";
import { mintCredential } from "../identity/credentials.js";
import { listen } from "../http/server.js";
import { tempDbPath } from "./test-support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(HERE, "../../../../packages/skill/install.mjs");
const PROXY = resolve(HERE, "../../../../packages/skill/proxy.mjs");

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

      // OpenCode config (V2 shape): a local stdio bridge entry — no
      // secret in the tracked file, and no env-substitution fragility.
      const oc = JSON.parse(
        readFileSync(join(dir, "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(oc["$schema"]).toBe("https://opencode.ai/config.json");
      const polymer = (
        oc["mcp"] as Record<string, Record<string, Record<string, unknown>>>
      ).servers["polymer"];
      expect(polymer["type"]).toBe("local");
      expect(polymer["command"]).toEqual([
        process.execPath,
        expect.stringContaining("proxy.mjs"),
        "--dir",
        dir,
      ]);
      expect(JSON.stringify(oc)).not.toContain(rc["session_token"] as string);
      expect(JSON.stringify(oc)).not.toContain(
        rc["reconnect_secret"] as string,
      );

      // AGENTS.md carries exactly one managed Polymer section.
      const agentsMd = readFileSync(join(dir, "AGENTS.md"), "utf8");
      expect(agentsMd.split("<!-- polymer:start -->").length - 1).toBe(1);
      expect(agentsMd).toContain(app.url);
      expect(agentsMd).toContain("Do not hand-roll HTTP");
      // OpenCode path writes no CLAUDE.md.
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);

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
      const agentsMd2 = readFileSync(join(dir, "AGENTS.md"), "utf8");
      expect(agentsMd2.split("<!-- polymer:start -->").length - 1).toBe(1);
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

  it("--client claude emits Claude's transport type; bogus clients fail usage", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-skill-"),
    });
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const dir = tempRepo();
      const claude = await install(app, dir, [
        "--name",
        "claude-agent",
        "--init-token-id",
        credential.credential_id,
        "--init-token",
        secret,
        "--client",
        "claude",
      ]);
      expect(claude.status).toBe(0);
      const mcp = JSON.parse(
        readFileSync(join(dir, ".mcp.json"), "utf8"),
      ) as Record<string, unknown>;
      const entry = (
        mcp["mcpServers"] as Record<
          string,
          { type: string; command: string; args: string[] }
        >
      )["polymer"]!;
      expect(entry.type).toBe("stdio");
      expect(entry.args).toEqual([PROXY, "--dir", dir]);
      // No secret and no env-var indirection anywhere in the config.
      const raw = readFileSync(join(dir, ".mcp.json"), "utf8");
      expect(raw).not.toContain("POLYMER_SESSION_TOKEN");
      expect(raw).not.toContain(
        (
          JSON.parse(readFileSync(join(dir, ".polymrc"), "utf8")) as {
            session_token: string;
          }
        ).session_token,
      );

      // The written entry itself reaches the server with no env secret.
      const client = new Client({ name: "claude-entry", version: "0.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: entry.command,
          args: entry.args,
          env: { PATH: process.env["PATH"] ?? "" },
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

      // CLAUDE.md imports AGENTS.md via one managed block; no secret.
      const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(claudeMd).toContain("@AGENTS.md");
      expect(claudeMd.split("<!-- polymer:start -->").length - 1).toBe(1);
      expect(claudeMd).not.toContain(
        (
          JSON.parse(readFileSync(join(dir, ".polymrc"), "utf8")) as {
            session_token: string;
          }
        ).session_token,
      );
      // Rerun is idempotent; a stale block is refreshed in place and
      // surrounding user content is preserved.
      writeFileSync(
        join(dir, "CLAUDE.md"),
        "# mine\n\n<!-- polymer:start -->\nstale\n<!-- polymer:end -->\n\ntail\n",
      );
      const rerun = await install(app, dir, [
        "--name",
        "claude-agent",
        "--client",
        "claude",
      ]);
      expect(rerun.status).toBe(0);
      const claudeMd2 = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(claudeMd2).toBe(
        "# mine\n\n<!-- polymer:start -->\n@AGENTS.md\n<!-- polymer:end -->\n\ntail\n",
      );
      // Existing CLAUDE.md without a block is appended to, never clobbered.
      const dir2 = tempRepo();
      writeFileSync(join(dir2, "CLAUDE.md"), "# keep me\n");
      const { credential: c2, secret: s2 } = mintCredential(app.db!, {
        type: "init",
      });
      const appended = await install(app, dir2, [
        "--name",
        "claude-agent-2",
        "--init-token-id",
        c2.credential_id,
        "--init-token",
        s2,
        "--client",
        "claude",
      ]);
      expect(appended.status).toBe(0);
      expect(readFileSync(join(dir2, "CLAUDE.md"), "utf8")).toBe(
        "# keep me\n\n<!-- polymer:start -->\n@AGENTS.md\n<!-- polymer:end -->\n",
      );

      const bogus = await install(app, tempRepo(), [
        "--name",
        "x",
        "--client",
        "cursor",
      ]);
      expect(bogus.status).toBe(2);
      expect(bogus.stderr).toContain("--client must be opencode or claude");
    } finally {
      await app.close();
    }
  }, 60000);

  it("merges into an existing opencode.json and refuses to clobber a different polymer entry", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-skill-"),
    });
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });

      // Existing settings survive the merge.
      const dir = tempRepo();
      writeFileSync(
        join(dir, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            model: "existing/model",
            mcp: {
              servers: {
                other: { type: "remote", url: "https://mcp.other.example/mcp" },
              },
            },
          },
          null,
          2,
        ),
      );
      const merged = await install(app, dir, [
        "--name",
        "merge-agent",
        "--init-token-id",
        credential.credential_id,
        "--init-token",
        secret,
      ]);
      expect(merged.status).toBe(0);
      const oc = JSON.parse(
        readFileSync(join(dir, "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(oc["model"]).toBe("existing/model");
      const servers = (oc["mcp"] as Record<string, Record<string, unknown>>)
        .servers as Record<string, unknown>;
      expect(servers["other"]).toBeDefined();
      expect(servers["polymer"]).toBeDefined();

      // A different, pre-existing "polymer" entry is never clobbered.
      const conflictDir = tempRepo();
      writeFileSync(
        join(conflictDir, "opencode.json"),
        JSON.stringify(
          {
            mcp: {
              servers: {
                polymer: {
                  type: "remote",
                  url: "https://elsewhere.example/mcp",
                },
              },
            },
          },
          null,
          2,
        ),
      );
      const { credential: c2, secret: s2 } = mintCredential(app.db!, {
        type: "init",
      });
      const conflict = await install(app, conflictDir, [
        "--name",
        "conflict-agent",
        "--init-token-id",
        c2.credential_id,
        "--init-token",
        s2,
      ]);
      expect(conflict.status).toBe(1);
      expect(conflict.stderr).toContain('different "polymer"');
      const untouched = JSON.parse(
        readFileSync(join(conflictDir, "opencode.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(
        (
          (untouched["mcp"] as Record<string, Record<string, unknown>>).servers[
            "polymer"
          ] as Record<string, unknown>
        )["url"],
      ).toBe("https://elsewhere.example/mcp");
    } finally {
      await app.close();
    }
  }, 60000);

  it("--client claude merges into an existing .mcp.json, never clobbering other servers, a different polymer entry, or malformed files", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-skill-"),
    });
    let n = 0;
    const run = async (dir: string, content: string) => {
      const path = join(dir, ".mcp.json");
      if (content) writeFileSync(path, content);
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const res = await install(app, dir, [
        "--name",
        `mcp-merge-${++n}`,
        "--init-token-id",
        credential.credential_id,
        "--init-token",
        secret,
        "--client",
        "claude",
      ]);
      return { res, path };
    };
    try {
      const dir = tempRepo();
      const other = { type: "http", url: "https://mcp.other.example/mcp" };
      const { res, path } = await run(
        dir,
        JSON.stringify({ keep: 1, mcpServers: { other } }),
      );
      expect(res.status).toBe(0);
      const merged = JSON.parse(readFileSync(path, "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(merged["keep"]).toBe(1);
      expect(merged["mcpServers"]?.["other"]).toEqual(other);
      expect(merged["mcpServers"]?.["polymer"]).toBeDefined();

      // Rerun is idempotent.
      const before = readFileSync(path, "utf8");
      expect((await run(dir, "")).res.status).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(before);

      // A different polymer entry is refused and the file is untouched.
      const conflict = JSON.stringify({
        mcpServers: { polymer: { type: "http", url: "https://x.example/mcp" } },
      });
      const c = await run(tempRepo(), conflict);
      expect(c.res.status).toBe(1);
      expect(c.res.stderr).toContain('different "polymer"');
      expect(readFileSync(c.path, "utf8")).toBe(conflict);

      // The pre-#171 http entry is upgraded to stdio in place.
      const legacyDir = tempRepo();
      const l = await run(
        legacyDir,
        JSON.stringify({
          mcpServers: {
            polymer: {
              type: "http",
              url: `${app.url}/mcp`,
              headers: { Authorization: "Bearer ${POLYMER_SESSION_TOKEN}" },
            },
          },
        }),
      );
      expect(l.res.status).toBe(0);
      const upgraded = JSON.parse(readFileSync(l.path, "utf8")) as {
        mcpServers: { polymer: { type: string } };
      };
      expect(upgraded.mcpServers.polymer.type).toBe("stdio");

      // Malformed JSON is refused and the file is untouched.
      const m = await run(tempRepo(), "{ not json");
      expect(m.res.status).toBe(1);
      expect(m.res.stderr).toContain("cannot parse");
      expect(readFileSync(m.path, "utf8")).toBe("{ not json");
    } finally {
      await app.close();
    }
  }, 60000);

  it("polymer-proxy bridges a real stdio client using .polymrc credentials", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-skill-"),
    });
    try {
      const dir = tempRepo();
      const otp = freshOtp(app);
      const run = await install(app, dir, [
        "--name",
        "proxy-agent",
        "--init-token-id",
        otp.id,
        "--init-token",
        otp.secret,
      ]);
      expect(run.status).toBe(0);

      // A real MCP client over stdio, exactly like OpenCode's local
      // entry: the proxy supplies the Bearer from `.polymrc` — no env.
      const client = new Client({ name: "proxy-test", version: "0.0.0" });
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [PROXY, "--dir", dir],
        }),
      );
      try {
        const ping = (await client.callTool({
          name: "ping",
          arguments: {},
        })) as { structuredContent: Record<string, unknown> };
        expect(ping.structuredContent["ok"]).toBe(true);
        const tools = await client.listTools();
        expect(tools.tools.length).toBeGreaterThan(0);
      } finally {
        await client.close();
      }

      // Missing credentials fail with a clear error, not a hang.
      const empty = mkdtempSync(join(tmpdir(), "polymer-skill-"));
      const bad = new Client({ name: "proxy-test", version: "0.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [PROXY, "--dir", empty],
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (c: Buffer | string) => {
        stderr += typeof c === "string" ? c : c.toString("utf8");
      });
      await expect(bad.connect(transport)).rejects.toThrow();
      expect(stderr).toContain("no usable credentials");
    } finally {
      await app.close();
    }
  }, 60000);

  it("the installer binary has no syntax errors", () => {
    execFileSync(process.execPath, ["--check", INSTALLER], { timeout: 15000 });
  });
});
