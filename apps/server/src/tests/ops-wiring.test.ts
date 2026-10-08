import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("operational wiring", () => {
  it("migration CLI scripts point at files that exist", () => {
    // The directory refactor left src/migrate.ts targets dangling and
    // no test noticed — pin the script targets to real files.
    // vitest runs with the package root as cwd.
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const script of ["migrate:up", "migrate:down", "migrate:reset"]) {
      const target = /\b(src\/[^\s"]+\.ts)\b/.exec(pkg.scripts[script])?.[1];
      expect(target, script).toBeTruthy();
      expect(readFileSync(join(process.cwd(), target!)).length).toBeGreaterThan(
        0,
      );
    }
  });
});
