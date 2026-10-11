/**
 * Shared `.polymrc` / environment resolution for the polymer scripts.
 * Precedence: environment (`POLYMER_SERVER`, `POLYMER_SESSION_TOKEN`,
 * `POLYMER_AGENT_ID`, `POLYMER_RECONNECT_SECRET`) first, then the
 * `.polymrc` JSON file in the working directory. Secrets are returned
 * to callers, never printed by this module.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveDir(dir) {
  return resolve(dir ?? ".");
}

export function readRcFile(dir) {
  const path = join(resolveDir(dir), ".polymrc");
  if (!existsSync(path)) return { path, rc: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null)
      return { path, rc: null };
    return { path, rc: parsed };
  } catch {
    return { path, rc: null };
  }
}

/**
 * Resolve connection config. Fields present in the environment win;
 * the rest fall back to `.polymrc`. Returns nulls for whatever is
 * still missing so callers can fail with usage, not guesses.
 */
export function resolveConfig(dir) {
  const { path, rc } = readRcFile(dir);
  return {
    rcPath: path,
    server: process.env.POLYMER_SERVER ?? rc?.server ?? null,
    agentId: process.env.POLYMER_AGENT_ID ?? rc?.agent_id ?? null,
    sessionToken:
      process.env.POLYMER_SESSION_TOKEN ?? rc?.session_token ?? null,
    reconnectSecret:
      process.env.POLYMER_RECONNECT_SECRET ?? rc?.reconnect_secret ?? null,
  };
}
