import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_PATH, createMcpServer } from "./mcp.js";
import { extractBearerToken, verifyTestCredential } from "./auth.js";
import { verifySessionToken } from "./credentials.js";
import { InitVerifyLimiter } from "./rate-limit.js";
import { closeDatabase, openDatabase, type PolymerDatabase } from "./db.js";

export const HEALTH_PATH = "/health";

export interface PolymerServer {
  server: Server;
  mcpServer: McpServer;
  db: PolymerDatabase | null;
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
  const mcpServer = createMcpServer(db);
  // OTP verification budget: 10 req/min per IP + server-global 60/min,
  // consumed BEFORE any token lookup (component 7).
  const initVerifyLimiter = new InitVerifyLimiter();
  // Stateful transport: one instance manages MCP sessions (one session id
  // per client) across requests on the shared port. Stateless mode forbids
  // transport reuse, and a single McpServer accepts only one transport, so
  // stateful is the smallest correct shape for a persistent ping tool.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  // Connect before accepting requests; the transport then routes each
  // request (by mcp-session-id) to this server.
  await mcpServer.connect(transport);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === HEALTH_PATH) {
        jsonResponse(res, 200, { ok: true });
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
        // Component 3+7: authenticate every MCP request at the HTTP layer.
        // Identity is derived from the Bearer credential, never from
        // caller-supplied arguments. DB agent-session tokens are tried
        // first (component 7); the in-memory test verifier (component 3)
        // remains for earlier suites. The single exemption is an
        // unauthenticated `register_agent` tools/call, which bootstraps
        // credentials and is OTP rate-limited below.
        const token = extractBearerToken(req.headers["authorization"]);
        let agentId: string | undefined;
        if (token !== undefined) {
          if (db) {
            const session = verifySessionToken(db, token);
            if (session.ok) agentId = session.principal.agentId;
          }
          if (agentId === undefined) {
            const verified = verifyTestCredential(token);
            if (!verified.ok) {
              jsonResponse(res, 401, {
                error: "unauthorized",
                reason: verified.reason,
              });
              return;
            }
            agentId = verified.principal.agentId;
          }
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
          res.writeHead(400, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            }),
          );
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
        await transport.handleRequest(req, res, body);
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

  return { server, mcpServer, db };
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
  const { server, mcpServer, db } = await createPolymerServer(options);
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  return {
    server,
    mcpServer,
    db: db as ListeningServer["db"],
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
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
      ),
  };
}
