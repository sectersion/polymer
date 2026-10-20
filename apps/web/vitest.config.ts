import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    // Mirror tsconfig `paths: { "@/*": ["./*"] }`: component modules
    // import via `@/…`, and unit tests import those components directly
    // (jsdom), so vitest must resolve the same alias — otherwise the
    // first component test fails with "Failed to resolve import".
    alias: { "@": WEB_DIR },
  },
  test: {
    // One hermetic production build per test run, shared by every
    // test file: concurrent `next build`s in one directory corrupt
    // each other (proven locally — two parallel builds, one exits 1),
    // so test files must never build for themselves. Each file still
    // boots its own backend + `next start` on ephemeral ports.
    globalSetup: [join(WEB_DIR, "tests", "setup-build.ts")],
    // Playwright drives `tests/e2e/*` (browser smoke, own runner +
    // its own CI job): never hand the browser spec to vitest.
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
  },
});
