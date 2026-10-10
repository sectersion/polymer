import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PolymerDatabase } from "../database/db.js";
import {
  ADMIN_SESSION_EXPIRY_SECONDS,
  INIT_TOKEN_DEFAULT_TTL_SECONDS,
  bootstrapMaster,
  createAdminSession,
  getAdminCsrf,
  masterBootstrapped,
  mintCredential,
  rotateMaster,
  verifyAdminSession,
  verifyCredential,
  type AdminSession,
} from "../identity/credentials.js";
import { listAudit } from "../identity/audit.js";
import { disableAgentSubtree } from "../identity/disable.js";
import { AdminOpsLimiter, LoginLimiter } from "../identity/rate-limit.js";
import {
  TASK_STATUSES,
  TASK_LEASE_DEFAULT_SECONDS,
  adminAssignTask,
  adminClaimTask,
  adminTransferCoordinator,
  adminUpdateTaskStatus,
  getTaskDetail,
  postComment,
  serializeTaskDetail,
  type TaskStatus,
} from "../tasks/index.js";

/**
 * Component 19: the administrator authentication + mutation surface.
 *
 * Auth state lives server-side: the master credential is the ONLY way
 * to log in (never shown to browser JS after setup), sessions are
 * short-lived rows behind the __Host-polymer_admin cookie, and every
 * state-changing call needs the session's CSRF token as
 * X-CSRF-Token (constant-time compare). Bypass mutations and master
 * rotation are audit-logged in the same transaction as the write.
 *
 * POST /api/agents/:id/disable is route-owned by this component per
 * the gate's ownership table (bounded-batch cascade with lease
 * release, in identity/disable.ts) — nothing pretends to disable.
 */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(
  req: IncomingMessage,
  maxBytes: number = 1024 * 1024,
): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: unknown): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
        finish(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return finish(undefined);
      try {
        finish(JSON.parse(raw));
      } catch {
        finish(undefined);
      }
    });
    req.on("error", () => finish(undefined));
  });
}

function invalidRequest(res: ServerResponse): void {
  sendJson(res, 400, { error: "invalid_request" });
}

const CATALOG_STATUS: Record<string, number> = {
  task_not_found: 404,
  agent_not_found: 404,
  not_found: 404,
  invalid_status: 400,
  invalid_cursor: 400,
  invalid_request: 400,
  already_assigned: 409,
  not_assigned: 400,
  task_already_claimed: 409,
  version_mismatch: 409,
  unauthorized: 403,
  name_taken: 409,
  invalid_role: 400,
};

function mapServiceError(res: ServerResponse, err: unknown): void {
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

function readAdminCookie(req: IncomingMessage): string | undefined {
  const header = req.headers["cookie"];
  if (typeof header !== "string") return undefined;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === "__Host-polymer_admin") {
      return pair.slice(eq + 1).trim();
    }
  }
  return undefined;
}

interface AdminAuth {
  credentialId: string;
}

function requireAdminSession(
  req: IncomingMessage,
  res: ServerResponse,
  db: PolymerDatabase,
): AdminAuth | undefined {
  const token = readAdminCookie(req);
  const verified =
    token !== undefined
      ? verifyAdminSession(db, token)
      : { ok: false as const };
  if (verified.ok) {
    return { credentialId: verified.credentialId };
  }
  sendJson(res, 401, { error: "invalid_token" });
  return undefined;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Read routes need the session; mutations need session + CSRF (403). */
function requireCsrf(
  req: IncomingMessage,
  res: ServerResponse,
  db: PolymerDatabase,
  auth: AdminAuth,
): boolean {
  const presented = req.headers["x-csrf-token"];
  const stored = getAdminCsrf(db, auth.credentialId);
  if (
    typeof presented === "string" &&
    stored !== undefined &&
    constantTimeStringEqual(presented, stored)
  ) {
    return true;
  }
  sendJson(res, 403, { error: "csrf_invalid" });
  return false;
}

function cookieSetCookieHeader(
  token: string,
  maxAgeSeconds: number,
  host: string,
): string {
  // __Host- prefix requires Secure + Path=/ + no Domain; Secure is
  // required whenever the listener is not loopback.
  const secure =
    host !== "127.0.0.1" && host !== "localhost" && host !== "::1"
      ? "; Secure"
      : "";
  return `__Host-polymer_admin=${token}; HttpOnly; SameSite=Lax; Path=/${secure}; Max-Age=${maxAgeSeconds}`;
}

const ADMIN_TASK_MUTATIONS = [
  "claim",
  "assign",
  "transfer-coordinator",
  "comments",
];

/** Does this path belong to the admin router? (GET /api/audit does.) */
export function isAdminPath(pathname: string, method: string): boolean {
  if (pathname.startsWith("/api/auth/")) return true;
  if (pathname === "/api/audit") return true;
  if (pathname === "/api/tokens" || pathname.startsWith("/api/tokens/")) {
    return true;
  }
  if (pathname.startsWith("/api/tasks/")) {
    const rest = pathname.slice("/api/tasks/".length);
    const tail = rest.split("/").pop() ?? "";
    // Only MUTATION methods belong here; GET stays with the readers.
    if (ADMIN_TASK_MUTATIONS.includes(tail) && method !== "GET") return true;
    if (method === "PATCH") return true;
  }
  if (
    pathname.startsWith("/api/agents/") &&
    pathname.endsWith("/disable") &&
    method === "POST"
  ) {
    return true;
  }
  return false;
}

export interface AdminLimiters {
  login: LoginLimiter;
  ops: AdminOpsLimiter;
}

/** Per-server limiter instances (same pattern as the OTP/refresh/MCP
 * limiters in server.ts): module-level singletons would share buckets
 * across every server in the process. */
export function createAdminLimiters(): AdminLimiters {
  return { login: new LoginLimiter(), ops: new AdminOpsLimiter() };
}

/** Handles every route in the admin surface; returns false when the
 * path belongs to the read-only REST module instead. */
export function handleAdminRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: PolymerDatabase,
  host: string,
  limiters: AdminLimiters,
  adminClaimEnabled: boolean,
): boolean {
  const { pathname } = url;
  if (!isAdminPath(pathname, req.method ?? "")) return false;

  try {
    const { login, ops } = limiters;
    const ip = req.socket.remoteAddress ?? "unknown";

    // --- auth ---
    if (pathname === "/api/auth/login" && req.method === "POST") {
      // Bucket consumed BEFORE the master credential is touched.
      if (!login.consume(ip)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      void readBody(req)
        .then((body) => {
          const master = (body as { master_credential?: unknown })
            ?.master_credential;
          if (typeof master !== "string" || master === "") {
            // Unknown/wrong credential is indistinguishable from a
            // missing body; failed attempts log nothing.
            sendJson(res, 401, { error: "invalid_token" });
            return;
          }
          const row = db
            .prepare(
              "SELECT credential_id FROM credentials WHERE type = 'master' LIMIT 1",
            )
            .get() as { credential_id: string } | undefined;
          const verified =
            row !== undefined
              ? verifyCredential(db, row.credential_id, master)
              : { ok: false as const };
          if (!verified.ok) {
            sendJson(res, 401, { error: "invalid_token" });
            return;
          }
          // No session fixation: any presented cookie is ignored and a
          // fresh session row is minted.
          const session: AdminSession = createAdminSession(db);
          res.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": cookieSetCookieHeader(
              session.token,
              ADMIN_SESSION_EXPIRY_SECONDS,
              host,
            ),
          });
          res.end(
            JSON.stringify({
              success: true,
              csrf_token: session.csrf_token,
              expires_in: session.expires_in,
              expires_at: session.expires_at,
            }),
          );
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }

    const auth = requireAdminSession(req, res, db);
    if (auth === undefined) return true;

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      // Delete the server-side session row; clear the cookie with
      // attributes identical to how it was set. (Live WebSocket close
      // is component 21's half.)
      db.prepare("DELETE FROM credentials WHERE credential_id = ?").run(
        auth.credentialId,
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": cookieSetCookieHeader("", 0, host),
      });
      res.end(JSON.stringify({ success: true }));
      return true;
    }

    if (pathname === "/api/auth/csrf" && req.method === "GET") {
      const csrf = getAdminCsrf(db, auth.credentialId);
      if (csrf === undefined) {
        sendJson(res, 401, { error: "invalid_token" });
        return true;
      }
      sendJson(res, 200, { csrf_token: csrf });
      return true;
    }

    if (pathname === "/api/auth/rotate-master" && req.method === "POST") {
      if (!login.consume(ip)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      if (!requireCsrf(req, res, db, auth)) return true;
      void readBody(req)
        .then(() => {
          const out = rotateMaster(db, auth.credentialId);
          sendJson(res, 200, out);
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }

    // --- tokens ---
    if (pathname === "/api/tokens" && req.method === "GET") {
      const rows = db
        .prepare(
          `SELECT credential_id, public_id, type, status, agent_id,
                  created_at, expires_at, last_used_at
             FROM credentials ORDER BY created_at ASC, rowid ASC`,
        )
        .all() as Record<string, unknown>[];
      sendJson(res, 200, { tokens: rows });
      return true;
    }

    if (
      pathname.startsWith("/api/tokens/") &&
      pathname !== "/api/tokens/init" &&
      req.method === "DELETE"
    ) {
      if (!requireCsrf(req, res, db, auth)) return true;
      const credentialId = pathname.slice("/api/tokens/".length);
      // Revocation is idempotent on existing rows (a used OTP is
      // already dead; revoking it changes nothing observable).
      const deleted = db
        .prepare(
          "UPDATE credentials SET status = 'revoked' WHERE credential_id = ?",
        )
        .run(credentialId);
      if (deleted.changes !== 1) {
        sendJson(res, 404, { error: "not_found" });
        return true;
      }
      sendJson(res, 200, { success: true });
      return true;
    }

    if (pathname === "/api/tokens/init" && req.method === "POST") {
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      if (!requireCsrf(req, res, db, auth)) return true;
      void readBody(req)
        .then(() => {
          // The master credential is accepted ONLY at /api/auth/login:
          // the body is ignored; an administrator session is the only
          // authority here. The plaintext OTP is returned once and
          // never stored.
          const { credential, secret } = mintCredential(db, {
            type: "init",
            agentId: null,
          });
          sendJson(res, 200, {
            init_token_id: credential.credential_id,
            init_token: secret,
            expires_in: INIT_TOKEN_DEFAULT_TTL_SECONDS,
            expires_at: credential.expires_at,
          });
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }

    // --- audit ---
    if (pathname === "/api/audit") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "method_not_allowed" });
        return true;
      }
      const page = listAudit(db, {
        taskId: url.searchParams.get("task_id") ?? undefined,
        limit: (() => {
          const raw = url.searchParams.get("limit");
          if (raw === null) return undefined;
          const n = Number(raw);
          if (!Number.isInteger(n) || n <= 0 || n > 500) {
            const err = new Error("invalid_request") as Error & {
              code: string;
            };
            err.code = "invalid_request";
            throw err;
          }
          return n;
        })(),
        cursor: url.searchParams.get("cursor") ?? undefined,
      });
      sendJson(res, 200, {
        audits: page.audits,
        next_cursor: page.next_cursor,
      });
      return true;
    }

    // --- agent disable ---
    if (
      pathname.startsWith("/api/agents/") &&
      pathname.endsWith("/disable") &&
      req.method === "POST"
    ) {
      if (!requireCsrf(req, res, db, auth)) return true;
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      const segments = pathname.split("/").filter((s) => s.length > 0);
      // /api/agents/:id/disable — the id is everything between.
      const targetId = segments.slice(2, -1).join("/");
      // Unknown ids surface as agent_not_found via the catalog mapper.
      const out = disableAgentSubtree(db, targetId, auth.credentialId);
      sendJson(res, 200, out);
      return true;
    }

    // --- task mutations ---
    if (pathname.startsWith("/api/tasks/")) {
      const rest = pathname.slice("/api/tasks/".length);
      const segments = rest.split("/");
      const taskId = segments[0] ?? "";
      const tail = segments[1];

      if (req.method === "PATCH" && segments.length === 1) {
        if (!requireCsrf(req, res, db, auth)) return true;
        if (!ops.consume(auth.credentialId)) {
          sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
          return true;
        }
        void readBody(req)
          .then((body) => {
            const patch = (body ?? {}) as Record<string, unknown>;
            const status = patch["status"];
            const expectedVersion = patch["expected_version"];
            const leaseGeneration = patch["lease_generation"];
            const force = patch["force"] === true;
            if (
              typeof status !== "string" ||
              typeof expectedVersion !== "number" ||
              typeof leaseGeneration !== "number"
            ) {
              invalidRequest(res);
              return;
            }
            if (
              !(TASK_STATUSES as readonly string[]).includes(status as string)
            ) {
              sendJson(res, 400, { error: "invalid_request" });
              return;
            }
            adminUpdateTaskStatus(
              db,
              taskId,
              auth.credentialId,
              status as TaskStatus,
              force,
              leaseGeneration as number,
              expectedVersion as number,
            );
            const detail = getTaskDetail(db, taskId);
            if (detail === undefined) {
              sendJson(res, 404, { error: "task_not_found" });
              return;
            }
            sendJson(res, 200, serializeTaskDetail(detail));
          })
          .catch((err: unknown) => mapServiceError(res, err));
        return true;
      }

      if (req.method === "POST" && ADMIN_TASK_MUTATIONS.includes(tail)) {
        if (!requireCsrf(req, res, db, auth)) return true;
        if (!ops.consume(auth.credentialId)) {
          sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
          return true;
        }
        void readBody(req)
          .then((raw) => {
            const body = (raw ?? {}) as Record<string, unknown>;
            const force = body["force"] === true;
            const expected = body["expected_version"];
            const generation = body["lease_generation"];
            if (tail === "claim") {
              if (!adminClaimEnabled) {
                sendJson(res, 403, { error: "unauthorized" });
                return;
              }
              const out = adminClaimTask(
                db,
                taskId,
                auth.credentialId,
                typeof body["lease_duration_seconds"] === "number"
                  ? (body["lease_duration_seconds"] as number)
                  : TASK_LEASE_DEFAULT_SECONDS,
              );
              sendJson(res, 200, out);
              return;
            }
            if (tail === "assign") {
              const agentIds = body["agent_ids"];
              if (
                typeof expected !== "number" ||
                typeof generation !== "number"
              ) {
                invalidRequest(res);
                return;
              }
              if (
                !Array.isArray(agentIds) ||
                !agentIds.every((x) => typeof x === "string")
              ) {
                invalidRequest(res);
                return;
              }
              adminAssignTask(
                db,
                taskId,
                auth.credentialId,
                agentIds as string[],
                force,
                generation as number,
                expected as number,
              );
              const detail = getTaskDetail(db, taskId);
              if (detail === undefined) {
                sendJson(res, 404, { error: "task_not_found" });
                return;
              }
              sendJson(res, 200, serializeTaskDetail(detail));
              return;
            }
            if (tail === "transfer-coordinator") {
              const newCoordinatorId = body["new_coordinator_id"];
              if (
                typeof expected !== "number" ||
                typeof generation !== "number" ||
                typeof newCoordinatorId !== "string"
              ) {
                invalidRequest(res);
                return;
              }
              adminTransferCoordinator(
                db,
                taskId,
                auth.credentialId,
                newCoordinatorId,
                force,
                generation as number,
                expected as number,
                typeof body["lease_duration_seconds"] === "number"
                  ? (body["lease_duration_seconds"] as number)
                  : TASK_LEASE_DEFAULT_SECONDS,
              );
              const detail = getTaskDetail(db, taskId);
              if (detail === undefined) {
                sendJson(res, 404, { error: "task_not_found" });
                return;
              }
              sendJson(res, 200, serializeTaskDetail(detail));
              return;
            }
            if (tail === "comments") {
              const content = body["content"];
              if (
                typeof content !== "string" ||
                (content as string).trim().length === 0
              ) {
                invalidRequest(res);
                return;
              }
              const traceParent =
                typeof body["trace_parent"] === "string"
                  ? (body["trace_parent"] as string)
                  : undefined;
              // Human sender identity is the administrator session
              // (sender_agent_id stays NULL, sender_type "human").
              const out = postComment(
                db,
                taskId,
                null,
                content as string,
                traceParent,
                "human",
              );
              sendJson(res, 200, { ...out, sender_agent_id: null });
              return;
            }
          })
          .catch((err: unknown) => mapServiceError(res, err));
        return true;
      }
    }

    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    mapServiceError(res, err);
    return true;
  }
}

/**
 * Component 19: master bootstrap at startup. If no master row exists,
 * one is generated and the plaintext is shown ONCE on stderr for the
 * operator; never logged elsewhere, never persisted as plaintext.
 */
export function bootstrapMasterCredential(
  db: PolymerDatabase,
  reporter?: (line: string) => void,
): void {
  if (masterBootstrapped(db)) return;
  const secret = bootstrapMaster(db);
  if (secret !== undefined) {
    reporter?.(
      "polymer master credential (save it now; it is not shown again): " +
        secret,
    );
  }
}
