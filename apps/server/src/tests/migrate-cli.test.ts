import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expect,
  it,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

/**
 * Component 4 CLI exercised as a real process over tsx (audit #27):
 * the migration tool's zero coverage lived in its subcommand
 * dispatch, which only a spawned `migrate.ts [up|down|reset]
 * [--db <path>]` reaches.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "..", "..");
// Resolved through the server package's own devDependencies (pnpm
// hoists nothing, so a fixed bin path never exists on disk).
const TSX_PKG = dirname(
  createRequire(join(SERVER_ROOT, "package.json")).resolve("tsx/package.json"),
);
const TSX_CLI = join(TSX_PKG, "dist", "cli.mjs");
const MIGRATE = resolve(SERVER_ROOT, "src/database/migrate.ts");

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function migrate(args: string[], dbPath?: string, env?: NodeJS.ProcessEnv) {
  return new Promise<Run>((resolveP, reject) => {
    const argv = [TSX_CLI, MIGRATE, ...args];
    if (dbPath !== undefined) argv.push("--db", dbPath);
    const child = spawn(process.execPath, argv, {
      timeout: 60_000,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (status) =>
      resolveP({ status: status ?? 1, stdout, stderr }),
    );
  });
}

function dbPath(file: string): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-migrate-")), file);
}

describe("migrate CLI (component 4, spawned)", () => {
  it("a fresh database migrates at OPEN time, so CLI up is a no-op saying so (the unreachable 'migrated' branch is deleted, audit #27)", async () => {
    const db = dbPath("db.sqlite");
    const run = await migrate(["up"], db);
    expect(run.status).toBe(0);
    expect(existsSync(db)).toBe(true);
    expect(run.stdout).toContain("already at schema version");
    expect(run.stdout).not.toContain("migrated");
  });

  it("after down, the next open re-applies and up confirms the head again", async () => {
    const db = dbPath("db.sqlite");
    const down = await migrate(["down"], db);
    expect(down.status).toBe(0);
    expect(down.stdout).toMatch(/rolled back version \d+/);
    const run = await migrate(["up"], db);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("already at schema version");
  });

  it("down rolls back one version", async () => {
    const db = dbPath("db.sqlite");
    await migrate(["up"], db);
    const down = await migrate(["down"], db);
    expect(down.status).toBe(0);
    expect(down.stdout).toMatch(/rolled back version \d+/);
  });

  it("reset tears down and re-applies from scratch", async () => {
    const db = dbPath("db.sqlite");
    const run = await migrate(["reset"], db);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("reset");
    // Still usable afterwards.
    expect((await migrate(["up"], db)).status).toBe(0);
  });

  it("an unknown command exits 1 with usage on stderr", async () => {
    const db = dbPath("db.sqlite");
    const run = await migrate(["sideways"], db);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("unknown command: sideways");
  });

  it("`--db` without a value falls back to the resolver (the flag-arg branch)", async () => {
    const db = dbPath("fallback.sqlite");
    const run = await migrate(["up", "--db"], undefined, {
      POLYMER_DATABASE_PATH: db,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("fallback.sqlite");
  });

  it("a missing --db flag falls back to POLYMER_DATABASE_PATH", async () => {
    const db = dbPath("env.sqlite");
    const run = await migrate(["up"], undefined, {
      POLYMER_DATABASE_PATH: db,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("env.sqlite");
    expect(existsSync(db)).toBe(true);
  });
});

// Same CLI dispatch, in-process, so v8 coverage can see it (spawned
// children are invisible to the reporter; audit #27). main() runs at
// import time, swallowing argv/env globally and restoring after.
describe("migrate CLI dispatch in-process (audit #27)", () => {
  const out: string[] = [];
  const err: string[] = [];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation((...c) => {
      out.push(c.join(" "));
    });
    errorSpy = vi.spyOn(console, "error").mockImplementation((...c) => {
      err.push(c.join(" "));
    });
  });

  beforeEach(() => {
    out.length = 0;
    err.length = 0;
    vi.resetModules();
  });

  afterAll(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  async function mainWith(argv: string[], envVar?: string): Promise<void> {
    const originalArgv = process.argv;
    const originalEnv = process.env.POLYMER_DATABASE_PATH;
    process.argv = ["node", "migrate.ts", ...argv];
    if (envVar === undefined) delete process.env.POLYMER_DATABASE_PATH;
    else process.env.POLYMER_DATABASE_PATH = envVar;
    try {
      // dynamic import; main() runs at import time
      await import("../database/migrate.js");
    } finally {
      process.argv = originalArgv;
      if (originalEnv === undefined) delete process.env.POLYMER_DATABASE_PATH;
      else process.env.POLYMER_DATABASE_PATH = originalEnv;
      vi.resetModules();
    }
  }

  it("up confirms the schema version (dispatch is reached in-process)", async () => {
    const db = dbPath("db.sqlite");
    process.exitCode = undefined;
    await mainWith(["up", "--db", db]);
    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("already at schema version");
  });

  it("reset works in-process and prints the fresh version", async () => {
    const db = dbPath("db.sqlite");
    await mainWith(["up", "--db", db]);
    await mainWith(["reset", "--db", db]);
    expect(out[1]).toMatch(/reset .* to schema version \d+/);
  });

  it("down rolls back one version in-process (head is always applied at open)", async () => {
    const db = dbPath("db.sqlite");
    await mainWith(["down", "--db", db]);
    expect(out[out.length - 1]).toMatch(/rolled back version \d+/);
  });

  it("unknown command sets exit status 1 and explains", async () => {
    const db = dbPath("db.sqlite");
    process.exitCode = undefined;
    await mainWith(["sideways", "--db", db]);
    expect(process.exitCode).toBe(1);
    expect(err.join("\n")).toContain("unknown command: sideways");
    process.exitCode = undefined;
  });

  it("no arguments at all default the command to `up`", async () => {
    process.exitCode = undefined;
    await mainWith([], undefined);
    expect(process.exitCode).toBeUndefined();
    expect(out.join("\n")).toContain("already at schema version");
    process.exitCode = undefined;
  });
});
