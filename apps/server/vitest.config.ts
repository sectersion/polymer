import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      // text-summary for the terminal, json-summary for the CI coverage
      // ratchet (issue #42): the PR comment diffs against main's summary.
      reporter: ["text-summary", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
