import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_PATH, createMcpServer } from "./mcp.js";
import { extractBearerToken } from "./auth.js";
import {
  RefreshError,
  refreshReconnect,
  verifySessionToken,
} from "./credentials.js";
import { InitVerifyLimiter, RefreshLimiter } from "./rate-limit.js";
import { closeDatabase, openDatabase, type PolymerDatabase } from "./db.js";

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
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
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

function readBody(req: IncomingMessage): Promise<unknown | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(Symbol.for("invalid-json") as unknown as undefined);
      }
    });
    req.on("error", reject);
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
  // One transport + McpServer per MCP client session. The stateful
  // transport accepts exactly one `initialize` for its lifetime, so a
  // single shared instance would let the first client — even an
  // unauthenticated one — consume the only session slot and wedge /mcp
  // for every other agent until restart. Stateless mode is not an
  // option: it forbids the session ids the agent-facing protocol needs.
  // Sessions are keyed by the SDK-generated id and removed on session
  // DELETE (`onsessionclosed`) or server shutdown.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
    const sessionServer = createMcpServer(db);
    const sessionTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, sessionTransport);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    await sessionServer.connect(sessionTransport);
    return sessionTransport;
  }

  const closeSessions = async (): Promise<void> => {
    for (const sessionTransport of sessions.values()) {
      try {
        await sessionTransport.close();
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
        const body = await readBody(req);
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          typeof body === "symbol"
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
            jsonResponse(res, 401, {
              error: "unauthorized",
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
        const body = await readBody(req);
        if (
          typeof body === "symbol" ||
          (body !== undefined &&
            (typeof body !== "object" || body === null || Array.isArray(body)))
        ) {
          // Malformed MCP request: clean JSON-RPC error, no crash.
          jsonRpcErrorResponse(res, 400, -32700, "Parse error");
          return;
        }
        if (agentId === undefined) {
          if (!isBootstrapCall(body)) {
            jsonResponse(res, 401, {
              error: "unauthorized",
              reason: "missing",
            });
            return;
          }
          if (isRegisterAgentCall(body)) {
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
          await existing.handleRequest(req, res, body);
          return;
        }
        if (isInitializeCall(body)) {
          const sessionTransport = await createSessionTransport();
          await sessionTransport.handleRequest(req, res, body);
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
