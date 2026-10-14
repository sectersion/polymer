import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { MCP_PATH, createMcpServer } from "../mcp/index.js";
import { attachUpgrade, EventBus, REVALIDATE_INTERVAL_MS } from "./events.js";
import { WebSocketServer } from "ws";
import { createAdminLimiters, handleAdminRequest } from "./admin.js";
import { DEFAULT_OTEL_OPTIONS, handleOtlpRequest } from "./otel.js";
import { TelemetryQueue } from "../telemetry/queue.js";
import {
  DEFAULT_RETENTION_DAYS,
  runTelemetryRetention,
} from "../telemetry/retention.js";
import { createLeaseNotifier, runLivenessSweep } from "../identity/watchdog.js";
import { handleRestRequest } from "./rest.js";
import { handleTelemetryRequest } from "./telemetry.js";
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
  resolveRateLimitIp,
} from "../identity/rate-limit.js";
import {
  closeDatabase,
  openDatabase,
  type PolymerDatabase,
} from "../database/db.js";
import { MAX_JSON_BODY_BYTES, MAX_REQUEST_BYTES, readBody } from "./common.js";

export const HEALTH_PATH = "/health";

export interface PolymerServer {
  server: Server;
  db: PolymerDatabase | null;
  /** End all live MCP sessions (used on shutdown so open SSE streams
   * do not hold `server.close()` open). */
  closeSessions: () => Promise<void>;
  /** Stop the telemetry timer and flush what is queued. Runs before
   * the database closes so a clean shutdown loses nothing buffered. */
  closeTelemetry: () => void;
  /** Stop the retention timer (component 28). */
  closeRetention: () => void;
  /** Stop the watchdog timers (component 29). */
  closeWatchdog: () => void;
  /** The fleet event bus (job emissions, live sockets). */
  events: EventBus;
}

export interface PolymerServerOptions {
  databasePath?: string;
  /** The host this server will be bound to (loopback default): drives
   * the Secure-flag requirement on the admin session cookie. */
  listenHost?: string;
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
  /** Design `ui.adminClaimEnabled` (default true): when false, the
   * admin claim route answers 403. Full POLYMER.json wiring arrives
   * with its component; this option is the gate until then. */
  adminClaimEnabled?: boolean;
  /** Component 22: OTLP base path (default "/otel"; full ingest path
   * is `<base>/v1/traces`). Disabled entirely when `false`. */
  telemetryEndpoint?: string;
  telemetryEnabled?: boolean;
  /** Component 22: raw byte cap per OTLP request (default 10 MiB). */
  telemetryMaxRequestBytes?: number;
  /** Component 22: max spans accepted per OTLP batch (default 500). */
  telemetryBatchMaxSpans?: number;
  /** Component 23: max batches held in memory (default 100). */
  telemetryQueueMaxBatches?: number;
  /** Component 23: flush interval in ms (default 1000). */
  telemetryBatchFlushMs?: number;
  /** Component 28: telemetry retention window in days (default 7).
   * Coordination history is never pruned by this job. */
  telemetryRetentionDays?: number;
  /** Component 28: retention sweep interval in ms (default 1h).
   * Pass 0 to disable the timer (manual runs still available). */
  telemetryRetentionIntervalMs?: number;
  /** Component 29: liveness sweep interval in ms (default 60s).
   * Pass 0 to disable the timer (manual runs still available). */
  livenessSweepIntervalMs?: number;
  /** Component 29: lease-expiry notifier interval in ms (default 60s).
   * Pass 0 to disable the timer (manual runs still available). */
  leaseNotifierIntervalMs?: number;
  /** Component 21: session-revalidation tick in ms (default 60s). A
   * backstop for missed events and crash recovery only — revocation
   * closes sockets immediately, never via this timer. */
  eventsRevalidateMs?: number;
  /** Explicit CIDR/IP list of trusted proxies. When set, rate-limit
   * IP keys resolve to the rightmost X-Forwarded-For entry outside
   * these ranges; otherwise the socket address is used. */
  trustedProxies?: string[];
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
  /** The agent bound to this session at creation, when the
   * initialize carried a valid Bearer credential. Anonymous
   * (bootstrap) sessions are unbound and can only ever receive the
   * unauthenticated surface. */
  ownerAgentId: string | undefined;
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
  // Admin budgets: login 5/min per IP + server-global 30/min, admin
  // ops 10/min per session — per-server instances, same as above.
  const adminLimiters = createAdminLimiters();
  const trustedProxies = options.trustedProxies ?? [];
  const clientIpFor = (req: IncomingMessage): string =>
    resolveRateLimitIp(
      req.socket.remoteAddress ?? "unknown",
      req.headers["x-forwarded-for"],
      trustedProxies,
    );
  // Component 23: the bounded telemetry queue. One per server; the
  // OTLP handler enqueues validated batches and the timer flushes
  // them to SQLite. Unref'd so tests never hang on the handle.
  const telemetryQueue = new TelemetryQueue(db, {
    maxBatches: options.telemetryQueueMaxBatches ?? 100,
    flushMs: options.telemetryBatchFlushMs ?? 1000,
  });
  telemetryQueue.start();
  // Component 21: the fleet event bus. One per server; passed to
  // every mutation surface (MCP tools + admin REST) so task, agent,
  // and comment changes publish to live admin sockets. Upgrade
  // wiring happens after the HTTP server exists (see below).
  const events = new EventBus();
  const wss = new WebSocketServer({ noServer: true });
  if (db !== null) {
    events.startRevalidation(
      db,
      options.eventsRevalidateMs ?? REVALIDATE_INTERVAL_MS,
    );
  }
  // transport accepts exactly one `initialize` for its lifetime, so a
  // single shared instance would let the first client — even an
  // unauthenticated one — consume the only session slot and wedge /mcp
  // for every other agent until restart. Stateless mode is not an
  // option: it forbids the session ids the agent-facing protocol needs.
  // Sessions are keyed by the SDK-generated id and removed on session
  // DELETE (`onsessionclosed`) or server shutdown.
  const sessions = new Map<string, McpSession>();

  async function createSessionTransport(
    ownerAgentId: string | undefined,
  ): Promise<StreamableHTTPServerTransport> {
    const sessionServer = createMcpServer(db, {
      testSeams: options.testSeams ?? false,
      events,
    });
    const sessionTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, {
          transport: sessionTransport,
          lastUsedAt: Date.now(),
          ownerAgentId,
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
    events.stopRevalidation();
    events.closeAll();
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
    const method = req.method ?? "";
    const rawPath = (req.url ?? "/").split("?")[0];
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
                  ip: clientIpFor(req),
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

      // Component 22: authenticated OTLP ingestion, kept completely
      // separate from the coordination APIs (own path prefix, own
      // auth, own limits). Checked before /api/ so the telemetry
      // endpoint can never collide with a coordination route.
      if (
        await handleOtlpRequest(
          req,
          res,
          url,
          db,
          {
            endpoint:
              options.telemetryEndpoint ?? DEFAULT_OTEL_OPTIONS.endpoint,
            enabled: options.telemetryEnabled ?? DEFAULT_OTEL_OPTIONS.enabled,
            maxRequestBytes:
              options.telemetryMaxRequestBytes ??
              DEFAULT_OTEL_OPTIONS.maxRequestBytes,
            batchMaxSpans:
              options.telemetryBatchMaxSpans ??
              DEFAULT_OTEL_OPTIONS.batchMaxSpans,
          },
          (batch) => telemetryQueue.enqueue(batch),
        )
      ) {
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        // Component 27 owns GET /api/telemetry/* (admin session
        // reads over actual stored telemetry). It answers only its
        // own paths; unknown telemetry paths 404 here, never fall
        // through to the coordination reads.
        if (handleTelemetryRequest(req, res, url, db)) {
          return;
        }
        // Component 19 owns the admin auth + mutation surface; it
        // answers only its own paths, leaving everything else to the
        // component-18 read routes (and their 405/404 layers).
        if (
          db !== null &&
          handleAdminRequest(
            req,
            res,
            url,
            db,
            options.listenHost ?? "127.0.0.1",
            adminLimiters,
            options.adminClaimEnabled ?? true,
            events,
            trustedProxies,
          )
        ) {
          return;
        }
        // Component 18: the read-only REST surface (admin session
        // cookie). /api/tokens/refresh above stays first: it has its
        // own reconnect-Bearer contract with no session.
        handleRestRequest(req, res, url, db);
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
          // Deliberately informational only: token, clientId, extra.
          // The raw Bearer secret is NOT carried on the request
          // context (nothing downstream needs it; carrying it put a
          // credential one logging bug away from every tool).
          (req as IncomingMessage & { auth?: unknown }).auth = {
            clientId: agentId,
            extra: { agentId },
          };
        }
        const body = await readBody(req, MAX_JSON_BODY_BYTES);
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
            const ip = clientIpFor(req);
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
        // requests key on the validated agent id; EVERYTHING
        // unauthenticated — the initialize handshake, bootstrap
        // notifications, register_agent, invalid-bearer probes —
        // consumes the source-IP budget, so probing credentials or
        // spamming keep-alives is rate-limited, never free. Session-
        // bound notifications from unauthenticated bootstrap clients
        // therefore no longer count as "free" traffic.
        const clientIp = clientIpFor(req);
        const limitKey =
          agentId !== undefined ? `agent:${agentId}` : `ip:${clientIp}`;
        if (!mcpLimiter.consume(limitKey)) {
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
          // A session created with a valid credential belongs to that
          // agent only: another principal's token (or an anonymous
          // caller) driving a foreign session gets 403 — the catalog
          // "authenticated but not permitted" — while bootstrap
          // sessions stay unbound because anonymous clients must be
          // able to complete register_agent on them.
          if (
            existing.ownerAgentId !== undefined &&
            existing.ownerAgentId !== agentId
          ) {
            jsonResponse(res, 403, { error: "unauthorized" });
            return;
          }
          // Only authenticated traffic extends session life: a
          // legitimate agent is back within the idle TTL the moment
          // it calls a tool, while keep-alive-spamming bootstrap
          // notifications cannot pin sessions into the cap forever.
          if (agentId !== undefined) {
            existing.lastUsedAt = Date.now();
          }
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
          const sessionTransport = await createSessionTransport(agentId);
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
    } catch (err) {
      // Never swallow a crash: log server side (identifiers only, no
      // request bodies or credentials) and answer catalog-style 500.
      console.error(
        JSON.stringify({
          event: "request_error",
          method,
          path: rawPath,
          at: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: "internal_error" });
      } else {
        res.end();
      }
    }
  });

  // Component 21: WebSocket upgrade routing. Only /api/events with a
  // database upgrades; everything else (and db-less servers) fails
  // the upgrade closed like every other surface. Handshakes consume
  // the login budget per IP first: verification costs DB lookups +
  // SHA-256, and unbounded upgrade spam would burn CPU with no
  // bucket. Exhausted budgets fail closed (destroy, no upgrade).
  if (db !== null) {
    const upgradeDb: PolymerDatabase = db;
    const handleUpgrade = attachUpgrade(wss, events, upgradeDb);
    server.on("upgrade", (req, socket, head) => {
      let pathname = "";
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== "/api/events") {
        socket.destroy();
        return;
      }
      const ip = clientIpFor(req);
      if (!adminLimiters.login.consume(ip)) {
        socket.destroy();
        return;
      }
      handleUpgrade(req, socket, head);
    });
  } else {
    server.on("upgrade", (_req, socket) => {
      socket.destroy();
    });
  }

  const closeTelemetry = (): void => {
    telemetryQueue.stop();
    try {
      telemetryQueue.flush();
    } catch (err) {
      // Best effort on the way out; the process is exiting anyway.
      console.error("telemetry final flush failed:", err);
    }
  };

  // Component 28: the incremental retention job. One timer per
  // server; each run is bounded (≤500 rows/table/txn, capped
  // iterations) so a deep backlog cannot monopolize the writer.
  // Unref'd so tests never hang on the handle. A failed run logs
  // counts-only context and retries on the next tick — retention
  // must never take down the server or wedge the timer.
  const retentionDays =
    options.telemetryRetentionDays ?? DEFAULT_RETENTION_DAYS;
  const retentionIntervalMs = options.telemetryRetentionIntervalMs ?? 3600_000;
  let retentionTimer: ReturnType<typeof setInterval> | undefined;
  if (db !== null && retentionIntervalMs > 0) {
    retentionTimer = setInterval(() => {
      try {
        const result = runTelemetryRetention(db, { retentionDays });
        if (result.spansDeleted > 0 || result.usageDeleted > 0) {
          console.log(
            JSON.stringify({
              event: "telemetry_retention",
              spansDeleted: result.spansDeleted,
              usageDeleted: result.usageDeleted,
              iterations: result.iterations,
              truncated: result.truncated,
              at: new Date().toISOString(),
            }),
          );
        }
      } catch (err) {
        console.error("telemetry retention failed:", err);
      }
    }, retentionIntervalMs);
    retentionTimer.unref?.();
  }
  const closeRetention = (): void => {
    if (retentionTimer !== undefined) {
      clearInterval(retentionTimer);
      retentionTimer = undefined;
    }
  };

  // Component 29: the two watchdog jobs, strictly separated. Job 1
  // flips stale agents to `disconnected` (liveness only — ownership
  // columns are never in its UPDATE). Job 2 only emits
  // `task.lease_expired` events and writes nothing. Both timers are
  // unref'd; either failing logs and retries next tick.
  const livenessIntervalMs = options.livenessSweepIntervalMs ?? 60_000;
  const notifierIntervalMs = options.leaseNotifierIntervalMs ?? 60_000;
  const notifier = createLeaseNotifier(events);
  let livenessTimer: ReturnType<typeof setInterval> | undefined;
  let notifierTimer: ReturnType<typeof setInterval> | undefined;
  if (db !== null && livenessIntervalMs > 0) {
    const sweepDb: PolymerDatabase = db;
    livenessTimer = setInterval(() => {
      try {
        const result = runLivenessSweep(sweepDb, events);
        if (result.marked.length > 0) {
          console.log(
            JSON.stringify({
              event: "liveness_sweep",
              marked: result.marked,
              truncated: result.truncated,
              at: new Date().toISOString(),
            }),
          );
        }
      } catch (err) {
        console.error("liveness sweep failed:", err);
      }
    }, livenessIntervalMs);
    livenessTimer.unref?.();
  }
  if (db !== null && notifierIntervalMs > 0) {
    const notifyDb: PolymerDatabase = db;
    notifierTimer = setInterval(() => {
      try {
        notifier.check(notifyDb);
      } catch (err) {
        console.error("lease notifier failed:", err);
      }
    }, notifierIntervalMs);
    notifierTimer.unref?.();
  }
  const closeWatchdog = (): void => {
    if (livenessTimer !== undefined) {
      clearInterval(livenessTimer);
      livenessTimer = undefined;
    }
    if (notifierTimer !== undefined) {
      clearInterval(notifierTimer);
      notifierTimer = undefined;
    }
  };

  return {
    server,
    db,
    closeSessions,
    closeTelemetry,
    closeRetention,
    closeWatchdog,
    events,
  };
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
  /** The fleet event bus (tests observe job emissions via replay). */
  events: EventBus;
}

export async function listen(
  host = "127.0.0.1",
  port = 0,
  options: PolymerServerOptions = {},
): Promise<ListeningServer> {
  const {
    server,
    db,
    closeSessions,
    closeTelemetry,
    closeRetention,
    closeWatchdog,
    events,
  } = await createPolymerServer({
    ...options,
    listenHost: host,
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const actualPort =
    typeof address === "object" && address !== null ? address.port : port;
  return {
    server,
    db: db as ListeningServer["db"],
    closeSessions,
    closeTelemetry,
    closeRetention,
    closeWatchdog,
    events,
    url: `http://${host}:${actualPort}`,
    close: async () => {
      await closeSessions();
      closeWatchdog();
      closeRetention();
      // Drain telemetry before the database closes: a clean shutdown
      // commits what a crash would lose (component 23's contract).
      closeTelemetry();
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
