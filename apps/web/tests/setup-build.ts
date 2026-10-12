import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Global setup: exactly one production build per `vitest run`,
 * shared by all test files. (Per-file builds race on the shared
 * `.next` directory — see vitest.config.ts.) Failure reports a long
 * log tail: the 500-char tails in per-file builders hid the real
 * Turbopack error more than once.
 */
export default async function setupBuild(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn("node", ["node_modules/next/dist/bin/next", "build"], {
      cwd: WEB_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(
      () => reject(new Error(`next build timed out: ${out.slice(-3000)}`)),
      300000,
    );
    build.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`next build exited ${code}: ${out.slice(-3000)}`));
    });
    build.stderr?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    build.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
  });
}
