import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildStartupMessage,
  DEFAULT_HOST,
  DEFAULT_PORT,
  isEntryPoint,
  VERSION,
} from "../index.js";

const SERVER_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENTRY = join(SERVER_ROOT, "src", "index.ts");
const ENTRY_URL = pathToFileURL(ENTRY).href;

describe("server skeleton", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });

  it("builds a clean startup message with defaults", () => {
    const msg = buildStartupMessage();
    expect(msg).toContain("polymer server");
    expect(msg).toContain(VERSION);
    expect(msg).toContain(DEFAULT_HOST);
    expect(msg).toContain(String(DEFAULT_PORT));
  });

  it("builds a startup message with explicit host/port", () => {
    expect(buildStartupMessage("127.0.0.1", 3000)).toBe(
      "polymer server v0.1.0 starting on 127.0.0.1:3000",
    );
  });
});

describe("entry guard (issue #136)", () => {
  it("recognises its own file under the platform's native separator", () => {
    // On win32 ENTRY is `C:\...\src\index.ts`; the old
    // endsWith("src/index.ts") guard returned false here.
    expect(isEntryPoint(ENTRY, ENTRY_URL)).toBe(true);
  });

  it("recognises a symlink to its file (pnpm bin links)", (ctx) => {
    const link = join(mkdtempSync(join(tmpdir(), "polymer-entry-")), "x.ts");
    try {
      symlinkSync(ENTRY, link);
    } catch {
      // Unprivileged Windows cannot create symlinks.
      ctx.skip();
    }
    expect(isEntryPoint(link, ENTRY_URL)).toBe(true);
  });

  it("rejects other files, missing paths and no argv[1]", () => {
    expect(isEntryPoint(join(SERVER_ROOT, "package.json"), ENTRY_URL)).toBe(
      false,
    );
    expect(isEntryPoint(join(SERVER_ROOT, "nope.js"), ENTRY_URL)).toBe(false);
    expect(isEntryPoint(undefined, ENTRY_URL)).toBe(false);
  });

  it("runs main() when spawned as a script: --help prints usage", () => {
    const tsxCli = join(
      dirname(
        createRequire(join(SERVER_ROOT, "package.json")).resolve(
          "tsx/package.json",
        ),
      ),
      "dist",
      "cli.mjs",
    );
    const run = spawnSync(process.execPath, [tsxCli, ENTRY, "--help"], {
      encoding: "utf8",
      timeout: 30000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("Usage: polymer-server");
  });
});
