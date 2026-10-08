import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("operational wiring", () => {
  it("migration CLI scripts point at files that exist", () => {
    // The directory refactor left src/migrate.ts targets dangling and
    // no test noticed — pin the script targets to real files.
    const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const pkg = JSON.parse(
      readFileSync(join(pkgDir, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    for (const script of ["migrate:up", "migrate:down", "migrate:reset"]) {
      const target = /\b(src\/[^\s"]+\.ts)\b/.exec(pkg.scripts[script])?.[1];
      expect(target, script).toBeTruthy();
      expect(readFileSync(join(pkgDir, target!)).length).toBeGreaterThan(0);
    }
  });
});
