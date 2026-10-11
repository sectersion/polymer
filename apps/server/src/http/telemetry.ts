import type { IncomingMessage, ServerResponse } from "node:http";
import type { PolymerDatabase } from "../database/db.js";
import { verifyAdminSession } from "../identity/credentials.js";
import { mapServiceError, readAdminCookie, sendJson } from "./common.js";
import {
  getCosts,
  getTelemetrySummary,
  listAgentTelemetry,
  listTimeline,
} from "../telemetry/queries.js";

/**
 * Component 27: `GET /api/telemetry/*` (summary, agents, timeline,
 * costs). Read-only admin-session routes — session cookie alone, no
 * CSRF (the read-only contract from the auth table). Non-GET answers
 * 405, like the component-18 read surface.
 */

function requireAdminSession(
  req: IncomingMessage,
  res: ServerResponse,
  db: PolymerDatabase,
): boolean {
  const token = readAdminCookie(req);
  if (token !== undefined && verifyAdminSession(db, token).ok) {
    return true;
  }
  sendJson(res, 401, { error: "invalid_token" });
  return false;
}

function limitOf(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 500) {
    const err = new Error("invalid_request") as Error & { code?: string };
    err.code = "invalid_request";
    throw err;
  }
  return parsed;
}

function param(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** True when this request is a component-27 route (handled or 405). */
export function handleTelemetryRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: PolymerDatabase | null,
): boolean {
  if (!url.pathname.startsWith("/api/telemetry/")) return false;
  if (req.method !== "GET") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!db) {
    sendJson(res, 503, { error: "database_error" });
    return true;
  }
  if (!requireAdminSession(req, res, db)) return true;

  try {
    if (url.pathname === "/api/telemetry/summary") {
      sendJson(res, 200, getTelemetrySummary(db));
      return true;
    }
    if (url.pathname === "/api/telemetry/agents") {
      sendJson(res, 200, listAgentTelemetry(db));
      return true;
    }
    if (url.pathname === "/api/telemetry/timeline") {
      sendJson(
        res,
        200,
        listTimeline(db, {
          from: param(url, "from"),
          to: param(url, "to"),
          agentId: param(url, "agent_id"),
          limit: limitOf(url),
          cursor: param(url, "cursor"),
        }),
      );
      return true;
    }
    if (url.pathname === "/api/telemetry/costs") {
      sendJson(
        res,
        200,
        getCosts(db, {
          granularity: param(url, "granularity"),
          from: param(url, "from"),
          to: param(url, "to"),
        }),
      );
      return true;
    }
    sendJson(res, 404, { error: "not_found" });
    return true;
  } catch (err) {
    mapServiceError(res, err);
    return true;
  }
}
