import type { IncomingMessage, ServerResponse } from "node:http";
import type { PolymerDatabase } from "../database/db.js";
import {
  MAX_JSON_BODY_BYTES,
  constantTimeStringEqual,
  mapServiceError,
  readAdminCookie,
  readBody,
  sendJson,
} from "./common.js";
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
import { listAudit, recordAudit } from "../identity/audit.js";
import {
  disableAgentSubtree,
  reenableAgentSubtree,
} from "../identity/disable.js";
import { updateAgentProfile } from "../identity/agents.js";
import {
  AdminOpsLimiter,
  LoginLimiter,
  resolveRateLimitIp,
} from "../identity/rate-limit.js";
import type { EventBus } from "./events.js";
import {
  TASK_STATUSES,
  TASK_LEASE_DEFAULT_SECONDS,
  adminAssignTask,
  adminBulkAssign,
  adminBulkUpdateStatus,
  adminClaimTask,
  adminTransferCoordinator,
  adminUpdateTaskStatus,
  decodeCursor,
  encodeCursor,
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

function invalidRequest(res: ServerResponse): void {
  sendJson(res, 400, { error: "invalid_request" });
}

/** Drop the internal rowid alias before serializing a page row. */
function stripRowid(
  row: Record<string, unknown> & { _rowid: number },
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row };
  delete copy._rowid;
  return copy;
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
  forwardedProto?: string | string[],
): string {
  // __Host- prefix requires Secure + Path=/ + no Domain; Secure is
  // required whenever the listener is not loopback or the request
  // arrived via a TLS-terminating proxy (X-Forwarded-Proto=https).
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]?.split(",")[0]?.trim().toLowerCase()
    : forwardedProto?.split(",")[0]?.trim().toLowerCase();
  const secure =
    host !== "127.0.0.1" && host !== "localhost" && host !== "::1"
      ? "; Secure"
      : proto === "https"
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
    // Bulk close-out routes are single-segment POSTs under /api/tasks/.
    if (ADMIN_TASK_MUTATIONS.includes(tail) && method !== "GET") return true;
    if ((rest === "bulk-status" || rest === "bulk-assign") && method === "POST")
      return true;
    if (method === "PATCH") return true;
  }
  if (
    pathname.startsWith("/api/agents/") &&
    (pathname.endsWith("/disable") || pathname.endsWith("/reenable")) &&
    method === "POST"
  ) {
    return true;
  }
  if (pathname.startsWith("/api/agents/") && method === "PATCH") {
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
  events: EventBus,
  trustedProxies: string[] = [],
): boolean {
  const { pathname } = url;
  if (!isAdminPath(pathname, req.method ?? "")) return false;

  try {
    const { login, ops } = limiters;
    const ip = resolveRateLimitIp(
      req.socket.remoteAddress ?? "unknown",
      req.headers["x-forwarded-for"],
      trustedProxies,
    );

    // --- auth ---
    if (pathname === "/api/auth/login" && req.method === "POST") {
      // Bucket consumed BEFORE the master credential is touched.
      if (!login.consume(ip)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      void readBody(req, MAX_JSON_BODY_BYTES)
        .then((result) => {
          if (result.kind === "too-large") {
            sendJson(
              res,
              413,
              { error: "payload_too_large" },
              { connection: "close" },
            );
            return;
          }
          const body = result.kind === "parsed" ? result.value : undefined;
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
              req.headers["x-forwarded-proto"],
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
      // State-changing: requires CSRF like every other mutation (the
      // console logout button proxies with a server-side token).
      if (!requireCsrf(req, res, db, auth)) return true;
      // Delete the server-side session row; clear the cookie with
      // attributes identical to how it was set. Live sockets for this
      // session close in the same obligation (component 21).
      db.prepare("DELETE FROM credentials WHERE credential_id = ?").run(
        auth.credentialId,
      );
      events.closeSocketsFor([auth.credentialId]);
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": cookieSetCookieHeader(
          "",
          0,
          host,
          req.headers["x-forwarded-proto"],
        ),
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
      void readBody(req, MAX_JSON_BODY_BYTES)
        .then((result) => {
          if (result.kind === "too-large") {
            sendJson(
              res,
              413,
              { error: "payload_too_large" },
              { connection: "close" },
            );
            return;
          }
          const out = rotateMaster(db, auth.credentialId);
          // Rotation revokes every live admin session: close every
          // live socket in the same obligation (component 21).
          events.closeAll();
          sendJson(res, 200, out);
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }

    // --- tokens ---
    if (pathname === "/api/tokens" && req.method === "GET") {
      // Uniform list conventions: limit default 50, max 500, opaque
      // cursor, terminal next_cursor null.
      let limit = 50;
      const rawLimit = url.searchParams.get("limit");
      if (rawLimit !== null) {
        const parsed = Number(rawLimit);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
          const err = new Error("invalid_request") as Error & {
            code: string;
          };
          err.code = "invalid_request";
          throw err;
        }
        limit = parsed;
      }
      const rawCursor = url.searchParams.get("cursor");
      let cursorRowid = 0;
      if (rawCursor !== null) {
        cursorRowid = decodeCursor(rawCursor);
      }
      const rows = db
        .prepare(
          `SELECT rowid AS _rowid, credential_id, public_id, type, status,
                  agent_id, created_at, expires_at, last_used_at
             FROM credentials WHERE rowid > ?
             ORDER BY created_at ASC, rowid ASC LIMIT ?`,
        )
        .all(cursorRowid, limit + 1) as Array<
        Record<string, unknown> & { _rowid: number }
      >;
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      sendJson(res, 200, {
        tokens: page.map(stripRowid),
        next_cursor: hasMore
          ? encodeCursor(page[page.length - 1]._rowid)
          : null,
      });
      return true;
    }

    if (
      pathname.startsWith("/api/tokens/") &&
      pathname !== "/api/tokens/init" &&
      req.method === "DELETE"
    ) {
      if (!requireCsrf(req, res, db, auth)) return true;
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
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
      // If this was a live admin session, its sockets close now
      // (agent credential ids simply have no tracked sockets).
      events.closeSocketsFor([credentialId]);
      sendJson(res, 200, { success: true });
      return true;
    }

    if (pathname === "/api/tokens/init" && req.method === "POST") {
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      if (!requireCsrf(req, res, db, auth)) return true;
      void readBody(req, MAX_JSON_BODY_BYTES)
        .then((result) => {
          if (result.kind === "too-large") {
            sendJson(
              res,
              413,
              { error: "payload_too_large" },
              { connection: "close" },
            );
            return;
          }
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
            // Additive convenience: the same OTP as one copyable line
            // (`<id>:<code>`). The split fields stay authoritative.
            onboarding_token: `${credential.credential_id}:${secret}`,
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
        entries: page.entries,
        next_cursor: page.next_cursor,
      });
      return true;
    }

    // --- agent disable / re-enable ---
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
      // Status events publish per newly-disabled agent only, so an
      // idempotent retry notifies nothing.
      const newlyDisabled: string[] = [];
      const out = disableAgentSubtree(
        db,
        targetId,
        auth.credentialId,
        (ids) => {
          newlyDisabled.push(...ids);
        },
      );
      for (const id of newlyDisabled) {
        events.publish("agent.status_changed", {
          agent_id: id,
          status: "disabled",
        });
      }
      sendJson(res, 200, out);
      return true;
    }

    if (
      pathname.startsWith("/api/agents/") &&
      pathname.endsWith("/reenable") &&
      req.method === "POST"
    ) {
      if (!requireCsrf(req, res, db, auth)) return true;
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      const segments = pathname.split("/").filter((s) => s.length > 0);
      // /api/agents/:id/reenable — the id is everything between.
      const targetId = segments.slice(2, -1).join("/");
      const newlyReenabled: string[] = [];
      const out = reenableAgentSubtree(
        db,
        targetId,
        auth.credentialId,
        (ids) => {
          newlyReenabled.push(...ids);
        },
      );
      for (const id of newlyReenabled) {
        events.publish("agent.status_changed", {
          agent_id: id,
          status: "idle",
        });
      }
      sendJson(res, 200, out);
      return true;
    }

    if (pathname.startsWith("/api/agents/") && req.method === "PATCH") {
      if (!requireCsrf(req, res, db, auth)) return true;
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      const targetId = pathname.slice("/api/agents/".length);
      void readBody(req, MAX_JSON_BODY_BYTES)
        .then((result) => {
          if (result.kind === "too-large") {
            sendJson(
              res,
              413,
              { error: "payload_too_large" },
              { connection: "close" },
            );
            return;
          }
          const patch = (
            result.kind === "parsed" ? result.value : {}
          ) as Record<string, unknown>;
          const name = patch["name"];
          const role = patch["role"];
          if (
            (name !== undefined && typeof name !== "string") ||
            (role !== undefined && typeof role !== "string") ||
            (name === undefined && role === undefined)
          ) {
            invalidRequest(res);
            return;
          }
          const before = db
            .prepare("SELECT name, role FROM agents WHERE agent_id = ?")
            .get(targetId) as { name: string; role: string } | undefined;
          const updated = updateAgentProfile(db, targetId, {
            ...(typeof name === "string" ? { name } : {}),
            ...(typeof role === "string" ? { role } : {}),
          });
          recordAudit(db, {
            actor_type: "admin_session",
            actor_id: auth.credentialId,
            action: "agent.profile.update",
            before: before ?? null,
            after: { name: updated.name, role: updated.role },
          });
          events.publish("agent.status_changed", {
            agent_id: updated.agent_id,
            status: updated.status,
          });
          sendJson(res, 200, updated);
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }

    // --- task mutations ---
    // Bulk close-out: force-bypass per-item status/assign with audit rows.
    if (pathname === "/api/tasks/bulk-status" && req.method === "POST") {
      if (!requireCsrf(req, res, db, auth)) return true;
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      void readBody(req, MAX_JSON_BODY_BYTES)
        .then((result) => {
          if (result.kind === "too-large") {
            sendJson(
              res,
              413,
              { error: "payload_too_large" },
              { connection: "close" },
            );
            return;
          }
          const body = (result.kind === "parsed" ? result.value : {}) as Record<
            string,
            unknown
          >;
          const taskIds = body["task_ids"];
          const status = body["status"];
          if (
            !Array.isArray(taskIds) ||
            !taskIds.every((x) => typeof x === "string") ||
            typeof status !== "string" ||
            !(TASK_STATUSES as readonly string[]).includes(status)
          ) {
            invalidRequest(res);
            return;
          }
          const out = adminBulkUpdateStatus(
            db,
            taskIds as string[],
            auth.credentialId,
            status as TaskStatus,
          );
          events.publish("task.updated", {
            change: "bulk-status",
            status,
            count: out.results.filter((r) => r.ok).length,
          });
          sendJson(res, 200, out);
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }
    if (pathname === "/api/tasks/bulk-assign" && req.method === "POST") {
      if (!requireCsrf(req, res, db, auth)) return true;
      if (!ops.consume(auth.credentialId)) {
        sendJson(res, 429, { error: "rate_limit_exceeded", retry_after: 60 });
        return true;
      }
      void readBody(req, MAX_JSON_BODY_BYTES)
        .then((result) => {
          if (result.kind === "too-large") {
            sendJson(
              res,
              413,
              { error: "payload_too_large" },
              { connection: "close" },
            );
            return;
          }
          const body = (result.kind === "parsed" ? result.value : {}) as Record<
            string,
            unknown
          >;
          const taskIds = body["task_ids"];
          const agentIds = body["agent_ids"];
          if (
            !Array.isArray(taskIds) ||
            !taskIds.every((x) => typeof x === "string") ||
            !Array.isArray(agentIds) ||
            !agentIds.every((x) => typeof x === "string")
          ) {
            invalidRequest(res);
            return;
          }
          const out = adminBulkAssign(
            db,
            taskIds as string[],
            auth.credentialId,
            agentIds as string[],
          );
          events.publish("task.updated", {
            change: "bulk-assign",
            count: out.results.filter((r) => r.ok).length,
          });
          sendJson(res, 200, out);
        })
        .catch((err: unknown) => mapServiceError(res, err));
      return true;
    }
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
        void readBody(req, MAX_JSON_BODY_BYTES)
          .then((result) => {
            if (result.kind === "too-large") {
              sendJson(
                res,
                413,
                { error: "payload_too_large" },
                { connection: "close" },
              );
              return;
            }
            const patch = (
              result.kind === "parsed" ? result.value : {}
            ) as Record<string, unknown>;
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
            events.publish("task.updated", {
              task_id: taskId,
              status: status as string,
              version: detail.task.version,
            });
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
        void readBody(req, MAX_JSON_BODY_BYTES)
          .then((result) => {
            if (result.kind === "too-large") {
              sendJson(
                res,
                413,
                { error: "payload_too_large" },
                { connection: "close" },
              );
              return;
            }
            const body = (
              result.kind === "parsed" ? result.value : {}
            ) as Record<string, unknown>;
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
              events.publish("task.updated", {
                task_id: out.task_id,
                status: out.status,
                coordinator: out.coordinator,
                version: out.version,
                lease_generation: out.lease_generation,
              });
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
              events.publish("task.updated", {
                task_id: taskId,
                change: "assigned",
                version: detail.task.version,
              });
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
              events.publish("task.updated", {
                task_id: taskId,
                change: "transfer_coordinator",
                coordinator: detail.task.coordinator,
                version: detail.task.version,
                lease_generation: detail.task.lease_generation,
              });
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
              events.publish("comment.created", {
                comment_id: out.comment_id,
                task_id: out.task_id,
                sender_agent_id: null,
                content: out.content,
              });
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
