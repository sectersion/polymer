import type { IncomingMessage, ServerResponse } from "node:http";
import type { PolymerDatabase } from "../database/db.js";
import {
  getAgentById,
  listAgents,
  AgentNotFoundError,
} from "../identity/agents.js";
import { verifyAdminSession } from "../identity/credentials.js";
import {
  getComments,
  getTaskDetail,
  listTaskAssignees,
  listTasksPage,
  serializeTaskDetail,
  taskListItem,
} from "../tasks/index.js";

/**
 * Component 18: the read-only REST surface ("the web/admin side").
 * Agents keep using MCP; these routes exist so a browser-side or
 * external client can inspect the same fleet state through the same
 * service layer. Mutations belong to component 19 (administrator
 * session + CSRF) — until then every non-GET answer is 405.
 *
 * Auth for reads: the admin session credential, presented as the
 * `__Host-polymer_admin` cookie (the shape component 19's login will
 * set). Today the session row is service-seeded.
 */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

const ADMIN_COOKIE = "__Host-polymer_admin";

function readAdminCookie(req: IncomingMessage): string | undefined {
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

function requireAdminSession(
  req: IncomingMessage,
  res: ServerResponse,
  db: PolymerDatabase,
): boolean {
  const token = readAdminCookie(req);
  if (token !== undefined && verifyAdminSession(db, token).ok) {
    return true;
  }
  // Catalog: invalid_token is the 401 code for a missing/unknown credential.
  sendJson(res, 401, { error: "invalid_token" });
  return false;
}

/** MCP-catalog error → HTTP status (design lines ~590-611). */
const CATALOG_STATUS: Record<string, number> = {
  task_not_found: 404,
  agent_not_found: 404,
  not_found: 404,
  invalid_status: 400,
  // Catalog extensions (unregistered upstream; register with 18).
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

/** Paginated reads share the limiting grammar: default 50, max 500. */
function limitOf(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
    // Handled by mapServiceError as a catalog extension code: 400.
    const err = new Error("invalid_request") as Error & { code?: string };
    err.code = "invalid_request";
    throw err;
  }
  return parsed;
}

function stringParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

export function handleRestRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: PolymerDatabase | null,
): void {
  if (req.method !== "GET") {
    // Mutations arrive with component 19 (administrator session + CSRF).
    sendJson(res, 405, { error: "method_not_allowed" });
    return;
  }
  if (!db) {
    // Catalog: a database-less server fails closed on every read, too.
    sendJson(res, 503, { error: "database_error" });
    return;
  }
  if (!requireAdminSession(req, res, db)) return;

  try {
    const { pathname } = url;

    if (pathname === "/api/agents") {
      sendJson(res, 200, { agents: listAgents(db) });
      return;
    }
    if (pathname.startsWith("/api/agents/")) {
      const agentId = pathname.slice("/api/agents/".length);
      const agent = getAgentById(db, agentId);
      if (agent === undefined) {
        throw new AgentNotFoundError(agentId);
      }
      sendJson(res, 200, agent);
      return;
    }
    if (pathname === "/api/tasks") {
      // One snapshot: task rows and their assignees composed exactly
      // like MCP get_tasks (the shared service builder + serializers).
      const body = db.transaction(() => {
        const page = listTasksPage(db, {
          status: stringParam(url, "status"),
          createdBy: stringParam(url, "created_by"),
          assignedTo: stringParam(url, "assigned_to"),
          limit: limitOf(url),
          cursor: stringParam(url, "cursor"),
        });
        return {
          tasks: page.tasks.map((task) =>
            taskListItem(
              task,
              listTaskAssignees(db, task.task_id).map((a) => a.agent_id),
            ),
          ),
          next_cursor: page.next_cursor,
        };
      })();
      sendJson(res, 200, body);
      return;
    }
    if (pathname.startsWith("/api/tasks/")) {
      const rest = pathname.slice("/api/tasks/".length);
      if (rest.endsWith("/comments")) {
        const taskId = rest.slice(0, -"/comments".length);
        const page = getComments(
          db,
          taskId,
          limitOf(url),
          stringParam(url, "cursor"),
        );
        sendJson(res, 200, page);
        return;
      }
      const detail = getTaskDetail(db, rest);
      if (detail === undefined) {
        sendJson(res, 404, { error: "task_not_found" });
        return;
      }
      sendJson(res, 200, serializeTaskDetail(detail));
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (err) {
    mapServiceError(res, err);
  }
}
