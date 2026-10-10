import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Shared HTTP plumbing for the REST, admin, and events modules.
 * One definition each: cookie parsing, JSON responses, and the
 * MCP-catalog → HTTP-status table (design lines ~590-611 plus the
 * registered `invalid_cursor`/`invalid_request` extensions).
 */

export const ADMIN_COOKIE = "__Host-polymer_admin";

export function readAdminCookie(req: IncomingMessage): string | undefined {
  const header = req.headers["cookie"];
  if (typeof header !== "string") return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === ADMIN_COOKIE) {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

export function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export const CATALOG_STATUS: Record<string, number> = {
  task_not_found: 404,
  agent_not_found: 404,
  not_found: 404,
  invalid_status: 400,
  // Catalog extensions (registered with component 18).
  invalid_cursor: 400,
  invalid_request: 400,
  already_assigned: 409,
  not_assigned: 400,
  task_already_claimed: 409,
  version_mismatch: 409,
  unauthorized: 403,
  name_taken: 409,
  invalid_role: 400,
  invalid_token: 401,
};

/**
 * Map a known service error to its catalog response and log nothing
 * (domain failures are client behavior, not incidents); unknown
 * errors rethrow so the server's request_error catch logs them.
 */
export function mapServiceError(res: ServerResponse, err: unknown): void {
  if (err instanceof Error && err.name === "SqliteError") {
    sendJson(res, 503, { error: "database_error" });
    return;
  }
  const code = (err as { code?: string } | undefined)?.code;
  if (typeof code === "string" && CATALOG_STATUS[code] !== undefined) {
    sendJson(res, CATALOG_STATUS[code], { error: code });
    return;
  }
  throw err;
}

/** General request body cap: `security.maxMessageSize` (design default 10 MiB). */
export const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
/**
 * MCP and admin JSON messages are small (tool args, JSON-RPC, form
 * bodies): cap them tighter than the general limit so an
 * unauthenticated stream cannot buffer megabytes before auth
 * (design parking lot: "MCP request body size cap ... 1 MiB + 413").
 */
export const MAX_JSON_BODY_BYTES = 1024 * 1024;

export type ReadBodyResult =
  | { kind: "parsed"; value: unknown }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "too-large" };

export function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: ReadBodyResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        // Stop buffering immediately; the caller replies 413 and the
        // connection is closed. Memory stays bounded regardless of how
        // much the client keeps sending.
        finish({ kind: "too-large" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") {
        finish({ kind: "empty" });
        return;
      }
      try {
        finish({ kind: "parsed", value: JSON.parse(raw) });
      } catch {
        finish({ kind: "invalid" });
      }
    });
    // The connection died mid-body; no response can be delivered anyway.
    req.on("error", () => finish({ kind: "invalid" }));
  });
}
