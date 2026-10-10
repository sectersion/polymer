import type { IncomingMessage, ServerResponse } from "node:http";
import type { PolymerDatabase } from "../database/db.js";
import { extractBearerToken } from "../identity/auth.js";
import { verifySessionToken } from "../identity/credentials.js";
import { OtelError, parseOtlpBatch } from "../telemetry/otlp.js";
import { readRawBody, sendJson } from "./common.js";

export interface OtelOptions {
  /** Base path (default "/otel"); the route is `<base>/v1/traces`. */
  endpoint: string;
  enabled: boolean;
  maxRequestBytes: number;
  batchMaxSpans: number;
}

export const DEFAULT_OTEL_OPTIONS: OtelOptions = {
  endpoint: "/otel",
  enabled: true,
  maxRequestBytes: 10 * 1024 * 1024,
  batchMaxSpans: 500,
};

function basePath(endpoint: string): string {
  return endpoint.endsWith("/") && endpoint.length > 1
    ? endpoint.slice(0, -1)
    : endpoint;
}

/**
 * Component 22: authenticated OTLP ingestion, kept completely
 * separate from the coordination APIs.
 *
 * Order: path → method → enabled → auth (before any byte is
 * buffered past the cap) → capped body → parse (content type, size,
 * count, structure). `200` means validated (the bounded queue of
 * component 23 decides what acceptance means for storage). The agent
 * identity comes from the Bearer credential alone — resource
 * attributes in the payload are never consulted for identity.
 */
export async function handleOtlpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: PolymerDatabase | null,
  options: OtelOptions,
): Promise<boolean> {
  if (url.pathname !== `${basePath(options.endpoint)}/v1/traces`) {
    return false;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "method_not_allowed" });
    return true;
  }
  if (!options.enabled) {
    sendJson(res, 404, { error: "not_found" });
    return true;
  }
  if (db === null) {
    sendJson(res, 503, { error: "database_error" });
    return true;
  }
  const token = extractBearerToken(req.headers["authorization"]);
  if (token === undefined || !verifySessionToken(db, token).ok) {
    sendJson(res, 401, { error: "invalid_token" });
    return true;
  }
  const body = await readRawBody(req, options.maxRequestBytes);
  if (body.kind === "too-large") {
    sendJson(res, 413, { error: "payload_too_large" }, { connection: "close" });
    return true;
  }
  try {
    parseOtlpBatch(
      req.headers["content-type"],
      body.bytes,
      options.batchMaxSpans,
    );
  } catch (err) {
    if (err instanceof OtelError) {
      const status = err.code === "payload_too_large" ? 413 : 400;
      sendJson(
        res,
        status,
        { error: err.code },
        status === 413 ? { connection: "close" } : {},
      );
      return true;
    }
    throw err;
  }
  // 200: validated. Storage (and its 503/429 semantics) arrives with
  // the queue (23) and span tables (24).
  res.writeHead(200, { "content-length": 0 });
  res.end();
  return true;
}
