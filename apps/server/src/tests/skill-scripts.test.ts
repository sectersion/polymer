import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
const SKILL_DIR = resolve(HERE, "../../../../packages/skill");
const INSTALLER = join(SKILL_DIR, "install.mjs");
const STATUS = join(SKILL_DIR, "status.mjs");
const REFRESH = join(SKILL_DIR, "refresh.mjs");

function runScript(
  script: string,
  dir: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  // Async spawn: the server under test lives in this process, and a
  // synchronous wait would deadlock it (see skill-installer tests).
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script, "--dir", dir], {
      env: { ...process.env, ...extraEnv },
      timeout: 30000,
    });
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

async function enroll(
  app: {
    url: string;
    db: NonNullable<Awaited<ReturnType<typeof listen>>["db"]>;
  },
  dir: string,
  name: string,
): Promise<Record<string, unknown>> {
  const { credential, secret } = mintCredential(app.db!, { type: "init" });
  const result: { status: number; stdout: string; stderr: string } =
    await new Promise((resolvePromise, reject) => {
      const child = spawn(
        process.execPath,
        [
          INSTALLER,
          "--server",
          app.url,
          "--dir",
          dir,
          "--name",
          name,
          "--init-token-id",
          credential.credential_id,
          "--init-token",
          secret,
        ],
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
        resolvePromise({ status: status ?? 1, stdout, stderr }),
      );
    });
  expect(result.status).toBe(0);
  return JSON.parse(readFileSync(join(dir, ".polymrc"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function pingOk(url: string, token: string): Promise<boolean> {
  const client = new Client({ name: "verify", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}${MCP_PATH}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    const ping = (await client.callTool({ name: "ping", arguments: {} })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    return ping.isError !== true && ping.structuredContent?.ok === true;
  } finally {
    await client.close();
  }
}

describe("agent roster/info and skill scripts (loose-end B)", () => {
  it("roster lists agents; info counts tasks; unknown is agent_not_found", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-roster-"),
    });
    try {
      const dirA = mkdtempSync(join(tmpdir(), "polymer-roster-"));
      const dirB = mkdtempSync(join(tmpdir(), "polymer-roster-"));
      const rcA = await enroll(app, dirA, "roster-a");
      const rcB = await enroll(app, dirB, "roster-b");
      const client = new Client({ name: "reader", version: "0.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`), {
          requestInit: {
            headers: { Authorization: `Bearer ${rcA["session_token"]}` },
          },
        }),
      );
      try {
        const roster = (await client.callTool({
          name: "get_agent_roster",
          arguments: {},
        })) as { structuredContent: Record<string, unknown> };
        const agents = roster.structuredContent["agents"] as Array<
          Record<string, unknown>
        >;
        expect(agents.map((a) => a["name"]).sort()).toEqual([
          "roster-a",
          "roster-b",
        ]);
        expect(Object.keys(agents[0]).sort()).toEqual(
          [
            "agent_id",
            "last_seen",
            "name",
            "parent_agent_id",
            "role",
            "status",
          ].sort(),
        );
        // A creates and claims; B gets assigned: counts diverge honestly.
        const created = (await client.callTool({
          name: "create_task",
          arguments: { title: "counted" },
        })) as { structuredContent: Record<string, unknown> };
        const taskId = created.structuredContent["task_id"] as string;
        await client.callTool({
          name: "claim_task",
          arguments: { task_id: taskId },
        });
        const detail = (await client.callTool({
          name: "get_task_detail",
          arguments: { task_id: taskId },
        })) as { structuredContent: Record<string, unknown> };
        await client.callTool({
          name: "assign_task",
          arguments: {
            task_id: taskId,
            agent_ids: [rcB["agent_id"]],
            lease_generation: detail.structuredContent["lease_generation"],
            expected_version: detail.structuredContent["version"],
          },
        });
        const infoA = (await client.callTool({
          name: "get_agent_info",
          arguments: { agent_id: rcA["agent_id"] },
        })) as { structuredContent: Record<string, unknown> };
        expect(infoA.structuredContent).toMatchObject({
          name: "roster-a",
          tasks_created: 1,
          tasks_assigned: 0,
        });
        const infoB = (await client.callTool({
          name: "get_agent_info",
          arguments: { agent_id: rcB["agent_id"] },
        })) as { structuredContent: Record<string, unknown> };
        expect(infoB.structuredContent).toMatchObject({
          tasks_created: 0,
          tasks_assigned: 1,
        });
        const missing = (await client.callTool({
          name: "get_agent_info",
          arguments: { agent_id: "no-such-agent" },
        })) as unknown as { isError?: boolean };
        expect(missing.isError).toBe(true);
        expect(JSON.stringify(missing)).toContain("agent_not_found");
      } finally {
        await client.close();
      }
    } finally {
      await app.close();
    }
  }, 60000);

  it("status reports connectivity; refresh rotates atomically and verifies", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-roster-"),
    });
    try {
      const dir = mkdtempSync(join(tmpdir(), "polymer-roster-"));
      const rc = await enroll(app, dir, "script-agent");
      const oldSession = rc["session_token"] as string;
      const oldReconnect = rc["reconnect_secret"] as string;

      const status = await runScript(STATUS, dir);
      expect(status.status).toBe(0);
      const body = JSON.parse(status.stdout) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, agent_id: rc["agent_id"] });
      expect(body["agents_seen"]).toBeGreaterThanOrEqual(1);
      expect(status.stdout).not.toContain(oldSession);

      const refresh = await runScript(REFRESH, dir);
      expect(refresh.status).toBe(0);
      const rc2 = JSON.parse(
        readFileSync(join(dir, ".polymrc"), "utf8"),
      ) as Record<string, unknown>;
      expect(rc2["session_token"]).not.toBe(oldSession);
      expect(rc2["reconnect_secret"]).not.toBe(oldReconnect);
      expect(rc2["agent_id"]).toBe(rc["agent_id"]);
      // Persist-then-use held: the fresh session answers…
      expect(await pingOk(app.url, rc2["session_token"] as string)).toBe(true);
      // …the old session still does too (reconnect-only invalidation)…
      expect(await pingOk(app.url, oldSession)).toBe(true);
      // …but the spent reconnect secret is dead on replay.
      const replay = await fetch(`${app.url}/api/tokens/refresh`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${oldReconnect}`,
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(replay.status).toBe(401);

      // No credentials, no service: clean usage failures, no secrets.
      const empty = await runScript(
        STATUS,
        mkdtempSync(join(tmpdir(), "polymer-roster-")),
      );
      expect(empty.status).toBe(1);
      expect(empty.stderr).toContain("no server/session");
    } finally {
      await app.close();
    }
  }, 60000);
});
