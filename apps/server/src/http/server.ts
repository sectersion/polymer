import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_PATH, createMcpServer } from "../mcp/index.js";
import { extractBearerToken } from "../identity/auth.js";
import {
  RefreshError,
  refreshReconnect,
  verifySessionToken,
} from "../identity/credentials.js";
import {
  InitVerifyLimiter,
  McpLimiter,
  RefreshLimiter,
} from "../identity/rate-limit.js";
import {
  closeDatabase,
  openDatabase,
  type PolymerDatabase,
} from "../database/db.js";

export const HEALTH_PATH = "/health";

export interface PolymerServer {
  server: Server;
  db: PolymerDatabase | null;
  /** End all live MCP sessions (used on shutdown so open SSE streams
   * do not hold `server.close()` open). */
  closeSessions: () => Promise<void>;
}

export interface PolymerServerOptions {
  databasePath?: string;
  /** MCP requests/min per agent and per source IP for anonymous
   * `initialize` handshakes. Design default 100 (tune with usage). */
  mcpRateLimitPerMin?: number;
  /** Hard cap on concurrent MCP sessions — a backstop behind the
   * per-IP handshake budget. Beyond it, `initialize` gets 429. */
  mcpMaxSessions?: number;
  /** Idle age past which a session becomes eligible for eviction.
   * Swept only under capacity pressure (at the cap), so below-cap
   * deployments never evict a connected-but-quiet client. */
  mcpSessionIdleMs?: number;
  /** Component 14: register test-only MCP probe tools. Default false —
   * probes never ship in production builds. */
  testSeams?: boolean;
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
}

function jsonResponse(
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

function jsonRpcErrorResponse(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  const text = JSON.stringify({
    jsonrpc: "2.0",
    id: null,
    error: { code, message },
  });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** General request body cap: `security.maxMessageSize` (design default 10 MiB). */
const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
/**
 * MCP messages are small (tool args, JSON-RPC): cap them tighter than
 * the general limit so an unauthenticated stream cannot buffer
 * megabytes before auth (design parking lot: "MCP request body size
 * cap ... 1 MiB + 413").
 */
const MAX_MCP_MESSAGE_BYTES = 1024 * 1024;

type ReadBodyResult =
  | { kind: "parsed"; value: unknown }
  | { kind: "empty" }
  | { kind: "invalid" }
  | { kind: "too-large" };

function readBody(
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

export async function createPolymerServer(
  options: PolymerServerOptions = {},
): Promise<PolymerServer> {
  const db = options.databasePath ? openDatabase(options.databasePath) : null;
  // OTP verification budget: 10 req/min per IP + server-global 60/min,
  // consumed BEFORE any token lookup (component 7).
  const initVerifyLimiter = new InitVerifyLimiter();
  // Refresh budget: 5 req/min per credential plus a server-global
  // cap of 60/min (component 9).
  const refreshLimiter = new RefreshLimiter();
  // MCP budget: 100 req/min per agent; the anonymous `initialize`
  // handshake is keyed by source IP. Session cap bounds total growth.
  const mcpLimiter = new McpLimiter(options.mcpRateLimitPerMin ?? 100);
  const maxSessions = options.mcpMaxSessions ?? 1000;
  const sessionIdleMs = options.mcpSessionIdleMs ?? 30 * 60_000;
  // One transport + McpServer per MCP client session. The stateful
  // transport accepts exactly one `initialize` for its lifetime, so a
  // single shared instance would let the first client — even an
  // unauthenticated one — consume the only session slot and wedge /mcp
  // for every other agent until restart. Stateless mode is not an
  // option: it forbids the session ids the agent-facing protocol needs.
  // Sessions are keyed by the SDK-generated id and removed on session
  // DELETE (`onsessionclosed`) or server shutdown.
  const sessions = new Map<string, McpSession>();

  async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
    const sessionServer = createMcpServer(db, {
      testSeams: options.testSeams ?? false,
    });
    const sessionTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          transport: sessionTransport,
          lastUsedAt: Date.now(),
        });
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    await sessionServer.connect(sessionTransport);
    return sessionTransport;
  }

  /** Drop sessions idle past the TTL. Called only at the cap, so a
   * stale fill cannot become a permanent initialize wedge: the next
   * handshake under pressure clears dead sessions before rejecting. */
  const sweepIdleSessions = (): void => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastUsedAt <= cutoff) {
        sessions.delete(sessionId);
        void session.transport.close().catch(() => {
          // Already closed; eviction is best-effort.
        });
      }
    }
  };

  /** Seconds until the oldest session becomes sweep-eligible: an
   * honest `retry_after` for cap-exhaustion 429s (a fixed 60 would
   * promise a retry that cannot succeed while the cap stays full). */
  const nextSessionExpiryInSeconds = (): number => {
    let oldest = Number.POSITIVE_INFINITY;
    for (const session of sessions.values()) {
      oldest = Math.min(oldest, session.lastUsedAt);
    }
    if (!Number.isFinite(oldest)) return 60;
    return Math.max(1, Math.ceil((oldest + sessionIdleMs - Date.now()) / 1000));
  };

  const closeSessions = async (): Promise<void> => {
    for (const session of sessions.values()) {
      try {
        await session.transport.close();
      } catch {
        // Session already closed; keep shutting the rest down.
      }
    }
    sessions.clear();
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === HEALTH_PATH) {
        jsonResponse(res, 200, { ok: true });
        return;
      }

      if (path === "/api/tokens/refresh") {
        // Component 9: reconnect rotation. The reconnect credential is
        // accepted here and nowhere else; identity comes from the
        // credential, never the body.
        if (req.method !== "POST") {
          jsonResponse(res, 405, { error: "method_not_allowed" });
          return;
        }
        if (!db) {
          jsonResponse(res, 503, { error: "database_error" });
          return;
        }
        const token = extractBearerToken(req.headers["authorization"]);
        if (token === undefined) {
          jsonResponse(res, 401, { error: "reconnect_secret_invalid" });
          return;
        }
        const dot = token.indexOf(".");
        if (!refreshLimiter.consume(dot <= 0 ? token : token.slice(0, dot))) {
          jsonResponse(res, 429, {
            error: "rate_limit_exceeded",
            retry_after: 60,
          });
          return;
        }
        const body = await readBody(req, MAX_REQUEST_BYTES);
        if (body.kind === "too-large") {
          jsonResponse(
            res,
            413,
            { error: "payload_too_large" },
            { connection: "close" },
          );
          return;
        }
        if (
          body.kind !== "parsed" ||
          typeof body.value !== "object" ||
          body.value === null ||
          Array.isArray(body.value)
        ) {
          jsonResponse(res, 400, { error: "invalid_request" });
          return;
        }
        try {
          const out = refreshReconnect(db, token);
          jsonResponse(res, 200, out);
        } catch (err) {
          if (err instanceof RefreshError) {
            if (err.code === "reconnect_already_used") {
              // Security event: no secret material, identifiers only.
              console.warn(
                JSON.stringify({
                  event: "reconnect_already_used",
                  credential_id: err.credentialId,
                  agent_id: err.agentId,
                  ip: req.socket.remoteAddress ?? "unknown",
                  at: new Date().toISOString(),
                }),
              );
            }
            jsonResponse(res, 401, { error: err.code });
            return;
          }
          if (err instanceof Error && err.name === "SqliteError") {
            // Driver failure during rotation: catalog maps
            // database_error to 503, not a bare 500.
            jsonResponse(res, 503, { error: "database_error" });
            return;
          }
          throw err;
        }
        return;
      }

      if (path === MCP_PATH) {
        if (
          req.method !== "POST" &&
          req.method !== "GET" &&
          req.method !== "DELETE"
        ) {
          jsonResponse(res, 405, { error: "method_not_allowed" });
          return;
        }
        // Component 8: authenticate every MCP request at the HTTP layer
        // against the real agent-session credentials in SQLite.
        // Identity is derived from the Bearer credential, never from
        // caller-supplied arguments. Only `agent_session` rows
        // authenticate (see verifySessionToken); reconnect credentials
        // authenticate nothing here. The single exemption is an
        // unauthenticated `register_agent` tools/call, which bootstraps
        // credentials and is OTP rate-limited below. Without a database
        // the server fails closed (401 on every MCP call).
        const token = extractBearerToken(req.headers["authorization"]);
        let agentId: string | undefined;
        if (token !== undefined && db) {
          const session = verifySessionToken(db, token);
          if (!session.ok) {
            // Catalog: invalid_token is the 401 code for a missing or
            // unknown/wrong credential (unauthorized is the 403 code
            // for an authenticated-but-not-permitted caller).
            jsonResponse(res, 401, {
              error: "invalid_token",
              reason: "invalid",
            });
            return;
          }
          agentId = session.principal.agentId;
          (req as IncomingMessage & { auth?: unknown }).auth = {
            token,
            clientId: agentId,
            scopes: [],
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            extra: { agentId },
          };
        }
        const body = await readBody(req, MAX_MCP_MESSAGE_BYTES);
        if (body.kind === "too-large") {
          jsonResponse(
            res,
            413,
            { error: "payload_too_large" },
            { connection: "close" },
          );
          return;
        }
        if (
          body.kind === "invalid" ||
          (body.kind === "parsed" &&
            (typeof body.value !== "object" ||
              body.value === null ||
              Array.isArray(body.value)))
        ) {
          // Malformed MCP request: clean JSON-RPC error, no crash.
          jsonRpcErrorResponse(res, 400, -32700, "Parse error");
          return;
        }
        const message = body.kind === "parsed" ? body.value : undefined;
        if (agentId === undefined) {
          if (!isBootstrapCall(message)) {
            jsonResponse(res, 401, {
              error: "invalid_token",
              reason: "missing",
            });
            return;
          }
          if (isRegisterAgentCall(message)) {
            const ip = req.socket.remoteAddress ?? "unknown";
            if (!initVerifyLimiter.consume(ip)) {
              jsonResponse(res, 429, {
                error: "rate_limit_exceeded",
                retry_after: 60,
              });
              return;
            }
          }
        }
        // MCP budget: consumed before any session work. Authenticated
        // requests key on the validated agent id; the unauthenticated
        // `initialize` handshake keys on the socket address so session
        // creation cannot be spammed. Session-bound notifications from
        // unauthenticated bootstrap clients ride an existing session
        // and create nothing, so they are not keyed here.
        const clientIp = req.socket.remoteAddress ?? "unknown";
        const limitKey =
          agentId !== undefined
            ? `agent:${agentId}`
            : isInitializeCall(message)
              ? `ip:${clientIp}`
              : undefined;
        if (limitKey !== undefined && !mcpLimiter.consume(limitKey)) {
          jsonResponse(res, 429, {
            error: "rate_limit_exceeded",
            retry_after: 60,
          });
          return;
        }
        // Route by session: existing sessions get their transport, a
        // fresh `initialize` gets a new one, everything else mirrors
        // the SDK's own session validation responses (404 unknown
        // session, 400 missing session id).
        const rawSessionId = req.headers["mcp-session-id"];
        const sessionId = Array.isArray(rawSessionId)
          ? rawSessionId[0]
          : rawSessionId;
        if (sessionId !== undefined && sessionId !== "") {
          const existing = sessions.get(sessionId);
          if (existing === undefined) {
            jsonRpcErrorResponse(res, 404, -32001, "Session not found");
            return;
          }
          existing.lastUsedAt = Date.now();
          await existing.transport.handleRequest(req, res, message);
          return;
        }
        if (isInitializeCall(message)) {
          // Sweep before the cap check: dead sessions free their slots
          // instead of stacking up against the reject path.
          sweepIdleSessions();
          if (sessions.size >= maxSessions) {
            jsonResponse(res, 429, {
              error: "rate_limit_exceeded",
              retry_after: nextSessionExpiryInSeconds(),
            });
            return;
          }
          const sessionTransport = await createSessionTransport();
          await sessionTransport.handleRequest(req, res, message);
          return;
        }
        jsonRpcErrorResponse(
          res,
          400,
          -32000,
          "Bad Request: Mcp-Session-Id header is required",
        );
        return;
      }

      jsonResponse(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    }
  });

  return { server, db, closeSessions };
}

function isInitializeCall(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  return (body as { method?: unknown }).method === "initialize";
}

function isRegisterAgentCall(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const msg = body as { method?: unknown; params?: { name?: unknown } };
  if (msg.method !== "tools/call") return false;
  return (
    (msg.params as { name?: unknown } | undefined)?.name === "register_agent"
  );
}

/**
 * Unauthenticated MCP bootstrap surface: session handshake plus the
 * single-use `register_agent` call. Everything else (tools/list,
 * any other tool) requires a Bearer credential and gets 401.
 */
function isBootstrapCall(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const msg = body as { method?: unknown };
  if (msg.method === "initialize") return true;
  if (msg.method === "notifications/initialized") return true;
  return isRegisterAgentCall(body);
}

export interface ListeningServer extends PolymerServer {
  url: string;
  close: () => Promise<void>;
}

export async function listen(
  host = "127.0.0.1",
  port = 0,
  options: PolymerServerOptions = {},
): Promise<ListeningServer> {
  const { server, db, closeSessions } = await createPolymerServer(options);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  return {
    server,
    db: db as ListeningServer["db"],
    closeSessions,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      await closeSessions();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => {
          if (db) {
            try {
              closeDatabase(db);
            } catch {
              // Server is already closing; surface the server error if any.
            }
          }
          if (err) reject(err);
          else resolve();
        }),
      );
    },
  };
}
