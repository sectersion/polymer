import { exec, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mintCredential } from "../identity/credentials.js";
import { listen } from "../http/server.js";
import { tempDbPath } from "./test-support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "../../../../packages/skill");

function run(
  script: string,
  args: string[],
): Promise<{ status: number; stdout: string; stderr: string }> {
  // Async spawn: the server under test shares this event loop.
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [join(SKILL, script), ...args], {
      timeout: 30000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", rej);
    child.on("close", (status) => res({ status: status ?? 1, stdout, stderr }));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("claude hooks drive heartbeat (#139)", () => {
  it("heartbeats without a tool call, throttles tool use, and never fails the session", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-hooks-"),
    });
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const dir = mkdtempSync(join(tmpdir(), "polymer-hooks-"));
      const settingsPath = join(dir, ".claude", "settings.local.json");
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(
        settingsPath,
        JSON.stringify({
          permissions: { allow: ["Bash(ls)"] },
          hooks: {
            PostToolUse: [{ hooks: [{ type: "command", command: "x" }] }],
          },
        }),
      );
      const install = [
        "--server",
        app.url,
        "--dir",
        dir,
        "--name",
        "hook-agent",
        "--init-token-id",
        credential.credential_id,
        "--init-token",
        secret,
        "--client",
        "claude",
      ];
      expect((await run("install.mjs", install)).status).toBe(0);
      expect((await run("install.mjs", install)).status).toBe(0);

      // Merged, not clobbered, idempotent.
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
        permissions: unknown;
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
      expect(settings.hooks["PostToolUse"]).toHaveLength(2);
      expect(settings.hooks["SessionStart"]).toHaveLength(1);
      expect(settings.hooks["SessionEnd"]).toHaveLength(1);
      const polymrc = readFileSync(join(dir, ".polymrc"), "utf8");
      const token = (JSON.parse(polymrc) as { session_token: string })
        .session_token;
      expect(JSON.stringify(settings)).not.toContain(token);

      const agentId = (JSON.parse(polymrc) as { agent_id: string }).agent_id;
      const lastSeen = () =>
        (
          app
            .db!.prepare("SELECT last_seen FROM agents WHERE agent_id = ?")
            .get(agentId) as { last_seen: string }
        ).last_seen;
      const hook = (mode: string) => run("hook.mjs", ["--dir", dir, mode]);

      let before = lastSeen();
      await sleep(20);
      // First tool use beats; an immediate second one is throttled.
      expect(await hook("tool")).toEqual({ status: 0, stdout: "", stderr: "" });
      expect(lastSeen() > before).toBe(true);
      before = lastSeen();
      await sleep(20);
      expect((await hook("tool")).status).toBe(0);
      expect(lastSeen()).toBe(before);

      // Session start and end are never throttled.
      for (const mode of ["session", "end"]) {
        await sleep(20);
        expect(await hook(mode)).toEqual({ status: 0, stdout: "", stderr: "" });
        expect(lastSeen() > before).toBe(true);
        before = lastSeen();
      }

      // Bad credential: quiet exit 0.
      const bad = mkdtempSync(join(tmpdir(), "polymer-hooks-bad-"));
      writeFileSync(
        join(bad, ".polymrc"),
        JSON.stringify({ server: app.url, session_token: "nope" }),
      );
      expect(await run("hook.mjs", ["--dir", bad, "session"])).toEqual({
        status: 0,
        stdout: "",
        stderr: "",
      });
    } finally {
      await app.close();
    }

    // Server down: quiet exit 0.
    const down = mkdtempSync(join(tmpdir(), "polymer-hooks-down-"));
    writeFileSync(
      join(down, ".polymrc"),
      JSON.stringify({ server: "http://127.0.0.1:1", session_token: "x" }),
    );
    expect(await run("hook.mjs", ["--dir", down, "session"])).toEqual({
      status: 0,
      stdout: "",
      stderr: "",
    });
    // No credentials at all: also quiet.
    const none = mkdtempSync(join(tmpdir(), "polymer-hooks-none-"));
    expect((await run("hook.mjs", ["--dir", none, "end"])).status).toBe(0);
  }, 120000);

  it("discloses hooks, quotes paths safely, refuses unsafe paths and bad settings, and survives a silent server", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-hooks-"),
    });
    try {
      const base = mkdtempSync(join(tmpdir(), "polymer-hooks-"));
      const args = (dir: string, name: string) => {
        const { credential, secret } = mintCredential(app.db!, {
          type: "init",
        });
        return [
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
          "--client",
          "claude",
        ];
      };

      // Path with a space: disclosed, and the written command really runs.
      const spaced = join(base, "with space");
      const ok = await run("install.mjs", args(spaced, "space-agent"));
      expect(ok.status).toBe(0);
      const settingsPath = join(spaced, ".claude", "settings.local.json");
      expect(JSON.parse(ok.stdout)["hooks"]).toBe(settingsPath);
      expect(ok.stderr).toContain(settingsPath);
      expect(ok.stderr).toContain("trust prompt");
      expect(readFileSync(join(spaced, ".gitignore"), "utf8")).toContain(
        ".polymer-hook-stamp",
      );
      const command = (
        JSON.parse(readFileSync(settingsPath, "utf8")) as {
          hooks: { SessionStart: { hooks: { command: string }[] }[] };
        }
      ).hooks.SessionStart[0]!.hooks[0]!.command;
      const agentId = (
        JSON.parse(readFileSync(join(spaced, ".polymrc"), "utf8")) as {
          agent_id: string;
        }
      ).agent_id;
      const lastSeen = () =>
        (
          app
            .db!.prepare("SELECT last_seen FROM agents WHERE agent_id = ?")
            .get(agentId) as { last_seen: string }
        ).last_seen;
      const before = lastSeen();
      await sleep(20);
      await new Promise<void>((res, rej) =>
        exec(command, { timeout: 30000 }, (err) => (err ? rej(err) : res())),
      );
      expect(lastSeen() > before).toBe(true);

      // Shell metacharacter in --dir: refused before anything is written.
      const evil = join(base, "a$(x)b");
      const refused = await run("install.mjs", args(evil, "evil-agent"));
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("contains one of");
      expect(existsSync(evil)).toBe(false);

      // Malformed / wrong-type settings: refused and left untouched.
      for (const [label, text] of [
        ["malformed", "{not json"],
        ["array", "[]"],
        ["hooks-array", '{"hooks": []}'],
        ["event-object", '{"hooks": {"SessionStart": {}}}'],
      ] as const) {
        const dir = join(base, label);
        mkdirSync(join(dir, ".claude"), { recursive: true });
        const p = join(dir, ".claude", "settings.local.json");
        writeFileSync(p, text);
        const bad = await run("install.mjs", args(dir, `bad-${label}`));
        expect(bad.status, label).not.toBe(0);
        expect(readFileSync(p, "utf8"), label).toBe(text);
      }
    } finally {
      await app.close();
    }

    // Server accepts the connection but never answers: exit 0 within budget.
    const sockets: import("node:net").Socket[] = [];
    const silent = createServer((s) => {
      s.on("error", () => {});
      sockets.push(s);
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    try {
      const port = (silent.address() as { port: number }).port;
      const hung = mkdtempSync(join(tmpdir(), "polymer-hooks-hung-"));
      writeFileSync(
        join(hung, ".polymrc"),
        JSON.stringify({
          server: `http://127.0.0.1:${port}`,
          session_token: "x",
        }),
      );
      const t0 = Date.now();
      const out = await run("hook.mjs", ["--dir", hung, "session"]);
      expect(out.status).toBe(0);
      expect(out.stdout).toBe("");
      expect(Date.now() - t0).toBeLessThan(8000);
    } finally {
      sockets.forEach((s) => s.destroy());
      silent.close();
    }
  }, 120000);
});
