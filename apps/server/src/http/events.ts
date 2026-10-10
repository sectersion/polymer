import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { PolymerDatabase } from "../database/db.js";
import { verifyAdminSession } from "../identity/credentials.js";

export interface FleetEvent {
  event_id: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

/** Bounded replay buffer: resume replays missed events, then live. */
const BUFFER_SIZE = 1000;
/** Application close code for failed handshakes (spec: 4401). */
export const HANDSHAKE_FAILED_CODE = 4401;
/** Session revalidation tick: backstop only, never the primary path. */
export const REVALIDATE_INTERVAL_MS = 60_000;

/**
 * Component 21: the fleet event bus + live-socket registry. Events
 * carry `{event_id, type, at, data}` with process-scoped sequential
 * ids; the bounded ring replays missed events to resuming clients.
 * Sockets are keyed by admin credential id so logout, revocation,
 * and rotation can close affected sockets in the same obligation as
 * the session-row change — the 60s revalidation tick is a backstop
 * for missed events and crash recovery only.
 */
export class EventBus {
  private nextId = 1;
  private readonly buffer: FleetEvent[] = [];
  private readonly sockets = new Map<string, Set<WebSocket>>();
  /**
   * Outbound queue per socket for events published while the
   * server-side socket is still CONNECTING. Without this, a mutation
   * landing in the milliseconds after handshake completion would be
   * silently dropped (the client already sees itself as open).
   */
  private readonly pending = new Map<WebSocket, FleetEvent[]>();
  private revalidateTimer: ReturnType<typeof setInterval> | undefined;
  private dbForRevalidation: PolymerDatabase | undefined;

  /**
   * Append an event; live subscribers receive it synchronously.
   *
   * Delivery contract (deliberate MVP scope): publishers call this
   * AFTER the mutation transaction commits, so a crash between commit
   * and publish loses the event permanently — replay cannot cover an
   * event that never entered the buffer. A durable outbox is a later
   * concern; socket *closes*, by contrast, fire in the same request
   * obligation as their row change.
   */
  publish(type: string, data: Record<string, unknown>): FleetEvent {
    const event: FleetEvent = {
      event_id: this.nextId++,
      type,
      at: new Date().toISOString(),
      data,
    };
    this.buffer.push(event);
    if (this.buffer.length > BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - BUFFER_SIZE);
    }
    for (const set of this.sockets.values()) {
      for (const socket of set) {
        this.deliver(socket, event);
      }
    }
    return event;
  }

  /** Deliver now if open, else queue for the open flush (in order). */
  deliver(socket: WebSocket, event: FleetEvent): void {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify(event));
      } catch {
        // Closed mid-send; the close handler untracks.
      }
      return;
    }
    let queue = this.pending.get(socket);
    if (queue === undefined) {
      queue = [];
      this.pending.set(socket, queue);
    }
    queue.push(event);
  }

  /** Events after `cursor` (exclusive); unknown cursors replay the
   * whole buffer — safe direction, never silent loss. */
  replay(cursor: string | undefined): FleetEvent[] {
    if (cursor === undefined) return [];
    const id = Number(cursor);
    if (!Number.isInteger(id)) return [...this.buffer];
    const index = this.buffer.findIndex((e) => e.event_id === id);
    if (index === -1) return [...this.buffer];
    return this.buffer.slice(index + 1);
  }

  track(credentialId: string, socket: WebSocket): void {
    let set = this.sockets.get(credentialId);
    if (set === undefined) {
      set = new Set();
      this.sockets.set(credentialId, set);
    }
    set.add(socket);
    if (socket.readyState === WebSocket.OPEN) {
      // Already open: delivers below go direct; nothing can be queued.
    } else {
      socket.once("open", () => {
        const queued = this.pending.get(socket);
        if (queued === undefined) return;
        this.pending.delete(socket);
        for (const event of queued) {
          this.deliver(socket, event);
        }
      });
    }
    const untrack = (): void => {
      this.pending.delete(socket);
      const live = this.sockets.get(credentialId);
      if (live !== undefined) {
        live.delete(socket);
        if (live.size === 0) this.sockets.delete(credentialId);
      }
    };
    socket.on("close", untrack);
    socket.on("error", untrack);
  }

  /** Close every socket for these credentials (logout/revocation). */
  closeSocketsFor(credentialIds: Iterable<string>): void {
    for (const id of credentialIds) {
      const set = this.sockets.get(id);
      if (set === undefined) continue;
      for (const socket of [...set]) {
        try {
          socket.close(HANDSHAKE_FAILED_CODE, "session revoked");
        } catch {
          // Already closing; the close handler untracks.
        }
      }
    }
  }

  /** Close every tracked socket (master rotation kills all sessions). */
  closeAll(): void {
    for (const id of [...this.sockets.keys()]) {
      this.closeSocketsFor([id]);
    }
  }

  liveSocketCount(): number {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  /** Start the 60s revalidation backstop against this database. */
  startRevalidation(
    db: PolymerDatabase,
    intervalMs: number = REVALIDATE_INTERVAL_MS,
  ): void {
    this.dbForRevalidation = db;
    this.revalidateTimer = setInterval(() => {
      this.revalidate();
    }, intervalMs);
    this.revalidateTimer.unref?.();
  }

  stopRevalidation(): void {
    if (this.revalidateTimer !== undefined) {
      clearInterval(this.revalidateTimer);
      this.revalidateTimer = undefined;
    }
  }

  private revalidate(): void {
    const db = this.dbForRevalidation;
    if (db === undefined) return;
    for (const [credentialId, set] of [...this.sockets.entries()]) {
      for (const socket of [...set]) {
        const row = db
          .prepare(
            "SELECT status, expires_at FROM credentials WHERE credential_id = ? AND type = 'admin_session'",
          )
          .get(credentialId) as
          { status: string; expires_at: string | null } | undefined;
        const dead =
          row === undefined ||
          row.status !== "active" ||
          (row.expires_at !== null && Date.now() >= Date.parse(row.expires_at));
        if (dead) {
          try {
            socket.close(HANDSHAKE_FAILED_CODE, "session revoked");
          } catch {
            // Already closing.
          }
        }
      }
    }
  }
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

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface HandshakeResult {
  ok: true;
  credentialId: string;
}

/**
 * Validate the upgrade handshake: administrator session cookie +
 * `?csrf=` validated like any state-changing request +
 * same-origin check. Browsers always send Origin; absent Origin means
 * a non-browser client, which still faces session + CSRF.
 */
export function validateHandshake(
  req: IncomingMessage,
  url: URL,
  db: PolymerDatabase,
): HandshakeResult | { ok: false } {
  const token = readAdminCookie(req);
  const verified =
    token !== undefined
      ? verifyAdminSession(db, token)
      : { ok: false as const };
  if (!verified.ok) return { ok: false };
  const presented = url.searchParams.get("csrf");
  // The row-held token comparison lives here (rather than reusing
  // the REST helper) to keep the upgrade path self-contained.
  const row = db
    .prepare(
      "SELECT csrf FROM credentials WHERE credential_id = ? AND type = 'admin_session'",
    )
    .get(verified.credentialId) as { csrf: string | null } | undefined;
  if (
    typeof presented !== "string" ||
    row?.csrf === null ||
    row?.csrf === undefined ||
    !constantTimeStringEqual(presented, row.csrf)
  ) {
    return { ok: false };
  }
  const origin = req.headers["origin"];
  if (typeof origin === "string") {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return { ok: false };
    }
    const host = req.headers["host"] ?? "";
    if (originHost !== host) return { ok: false };
  }
  return { ok: true, credentialId: verified.credentialId };
}

/** Accept the upgrade on this WebSocketServer, then handle resume. */
export function attachUpgrade(
  wss: WebSocketServer,
  bus: EventBus,
  db: PolymerDatabase,
): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  return (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/api/events", "http://localhost");
    } catch {
      socket.destroy();
      return;
    }
    const handshake = validateHandshake(req, url, db);
    // handleUpgrade emits 'connection' itself; failures complete the
    // handshake and then close with 4401 per the contract.
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!handshake.ok) {
        ws.close(HANDSHAKE_FAILED_CODE, "handshake failed");
        return;
      }
      bus.track(handshake.credentialId, ws);
      for (const event of bus.replay(
        url.searchParams.get("cursor") ?? undefined,
      )) {
        bus.deliver(ws, event);
      }
    });
  };
}
