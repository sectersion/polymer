import { randomUUID } from "node:crypto";
import type { PolymerDatabase } from "../database/db.js";

const AGENT_STATUSES = [
  "connecting",
  "connected",
  "idle",
  "working",
  "error",
  "disconnected",
  "disabled",
] as const;

type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface Agent {
  agent_id: string;
  name: string;
  role: string;
  parent_agent_id: string | null;
  status: AgentStatus;
  heartbeat_timeout_seconds: number;
  last_seen: string;
  connected_at: string;
  created_at: string;
}

interface CreateAgentInput {
  name: string;
  role: string;
  parentAgentId?: string | null;
  status?: AgentStatus;
  heartbeatTimeoutSeconds?: number;
}

export class AgentNameTakenError extends Error {
  readonly code = "name_taken";
  constructor(name: string) {
    super(`agent name already in use: ${name}`);
    this.name = "AgentNameTakenError";
  }
}

export class AgentNotFoundError extends Error {
  readonly code = "agent_not_found";
  constructor(agentId: string) {
    super(`agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

class InvalidAgentStatusError extends Error {
  readonly code = "invalid_status";
  constructor(status: string) {
    super(`invalid agent status: ${status}`);
    this.name = "InvalidAgentStatusError";
  }
}

class InvalidAgentRoleError extends Error {
  readonly code = "invalid_role";
  constructor(role: string) {
    super(`invalid agent role: ${role}`);
    this.name = "InvalidAgentRoleError";
  }
}

class InvalidCursorError extends Error {
  readonly code = "invalid_cursor";
  constructor() {
    super("invalid_cursor");
    this.name = "InvalidCursorError";
  }
}

function isAgentStatus(value: string): value is AgentStatus {
  return (AGENT_STATUSES as readonly string[]).includes(value);
}

function toAgent(row: Record<string, unknown>): Agent {
  return {
    agent_id: row["agent_id"] as string,
    name: row["name"] as string,
    role: row["role"] as string,
    parent_agent_id: (row["parent_agent_id"] as string | null) ?? null,
    status: row["status"] as AgentStatus,
    heartbeat_timeout_seconds: row["heartbeat_timeout_seconds"] as number,
    last_seen: row["last_seen"] as string,
    connected_at: row["connected_at"] as string,
    created_at: row["created_at"] as string,
  };
}

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * Component 5: agent service over raw SQL.
 * `parent_agent_id` is set only at creation; no updater touches it.
 */
export function createAgent(
  db: PolymerDatabase,
  input: CreateAgentInput,
): Agent {
  const name = input.name.trim();
  const role = input.role.trim();
  if (name === "") throw new Error("agent name must not be empty");
  if (role === "") throw new Error("agent role must not be empty");
  const status: AgentStatus = input.status ?? "connecting";
  if (!isAgentStatus(status)) throw new InvalidAgentStatusError(status);
  const heartbeatTimeout = input.heartbeatTimeoutSeconds ?? 300;
  if (!Number.isInteger(heartbeatTimeout) || heartbeatTimeout <= 0) {
    throw new Error("heartbeat_timeout_seconds must be a positive integer");
  }
  const parentAgentId = input.parentAgentId ?? null;
  if (parentAgentId !== null) {
    const parent = db
      .prepare("SELECT agent_id FROM agents WHERE agent_id = ?")
      .get(parentAgentId) as { agent_id: string } | undefined;
    if (!parent) throw new AgentNotFoundError(parentAgentId);
  }
  const agentId = randomUUID();
  try {
    const row = db
      .prepare(
        `INSERT INTO agents (agent_id, name, role, parent_agent_id, status, heartbeat_timeout_seconds)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING agent_id, name, role, parent_agent_id, status,
                   heartbeat_timeout_seconds, last_seen, connected_at, created_at`,
      )
      .get(agentId, name, role, parentAgentId, status, heartbeatTimeout) as
      Record<string, unknown> | undefined;
    if (!row) throw new Error("agent insert returned no row");
    return toAgent(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AgentNameTakenError(name);
    throw err;
  }
}

export function getAgentById(
  db: PolymerDatabase,
  agentId: string,
): Agent | undefined {
  const row = db
    .prepare(
      `SELECT agent_id, name, role, parent_agent_id, status,
              heartbeat_timeout_seconds, last_seen, connected_at, created_at
       FROM agents WHERE agent_id = ?`,
    )
    .get(agentId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toAgent(row);
}

/** Exact, case-sensitive name lookup (the mention-resolution key). */
export function getAgentByName(
  db: PolymerDatabase,
  name: string,
): Agent | undefined {
  const row = db
    .prepare(
      `SELECT agent_id, name, role, parent_agent_id, status,
              heartbeat_timeout_seconds, last_seen, connected_at, created_at
       FROM agents WHERE name = ?`,
    )
    .get(name) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toAgent(row);
}

export function listAgents(db: PolymerDatabase): Agent[] {
  const rows = db
    .prepare(
      `SELECT agent_id, name, role, parent_agent_id, status,
              heartbeat_timeout_seconds, last_seen, connected_at, created_at
       FROM agents ORDER BY created_at ASC, rowid ASC`,
    )
    .all() as Record<string, unknown>[];
  return rows.map(toAgent);
}

const AGENT_COLUMNS = `agent_id, name, role, parent_agent_id, status,
              heartbeat_timeout_seconds, last_seen, connected_at, created_at`;

function encodeAgentCursor(rowid: number): string {
  return Buffer.from(`c${rowid}`, "utf8").toString("base64url");
}

function decodeAgentCursor(cursor: string): number {
  let raw = "";
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCursorError();
  }
  if (!raw.startsWith("c")) throw new InvalidCursorError();
  const rowid = Number(raw.slice(1));
  if (!Number.isInteger(rowid) || rowid < 0) throw new InvalidCursorError();
  return rowid;
}

interface ListAgentsPageInput {
  status?: string;
  role?: string;
  parentAgentId?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Filtered, cursor-paginated roster shared by REST `GET /api/agents`
 * and MCP `get_agent_roster` (parity). Filters are exact matches;
 * `status` is validated against the catalog (`invalid_status`),
 * unknown cursors fail with `invalid_cursor`. Ordering matches
 * `listAgents` (created_at, rowid); `next_cursor` is null at the end.
 */
export function listAgentsPage(
  db: PolymerDatabase,
  input: ListAgentsPageInput = {},
): { agents: Agent[]; next_cursor: string | null } {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    const err = new Error("invalid_request") as Error & { code: string };
    err.code = "invalid_request";
    throw err;
  }
  const cursorRowid =
    input.cursor === undefined ? 0 : decodeAgentCursor(input.cursor);
  const where: string[] = ["rowid > ?"];
  const params: unknown[] = [cursorRowid];
  if (input.status !== undefined) {
    if (!isAgentStatus(input.status))
      throw new InvalidAgentStatusError(input.status);
    where.push("status = ?");
    params.push(input.status);
  }
  if (input.role !== undefined) {
    where.push("role = ?");
    params.push(input.role);
  }
  if (input.parentAgentId !== undefined) {
    where.push("parent_agent_id = ?");
    params.push(input.parentAgentId);
  }
  const rows = db
    .prepare(
      `SELECT rowid AS _rowid, ${AGENT_COLUMNS} FROM agents
       WHERE ${where.join(" AND ")}
       ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<
    Record<string, unknown> & { _rowid: number }
  >;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    agents: page.map(toAgent),
    next_cursor: hasMore
      ? encodeAgentCursor(page[page.length - 1]._rowid)
      : null,
  };
}

interface UpdateAgentProfileInput {
  name?: string;
  role?: string;
}

/**
 * Rename / role update (admin-only via `PATCH /api/agents/:id`).
 * Identity still comes from the admin session, never from a body
 * `agent_id`. UNIQUE on name races maps to `name_taken`, never 500.
 */
export function updateAgentProfile(
  db: PolymerDatabase,
  agentId: string,
  input: UpdateAgentProfileInput,
): Agent {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (name === "") {
      const err = new Error("invalid_request") as Error & { code: string };
      err.code = "invalid_request";
      throw err;
    }
    sets.push("name = ?");
    params.push(name);
  }
  if (input.role !== undefined) {
    const role = input.role.trim();
    if (role === "") throw new InvalidAgentRoleError(input.role);
    sets.push("role = ?");
    params.push(role);
  }
  if (sets.length === 0) {
    const err = new Error("invalid_request") as Error & { code: string };
    err.code = "invalid_request";
    throw err;
  }
  try {
    const row = db
      .prepare(
        `UPDATE agents SET ${sets.join(", ")} WHERE agent_id = ?
         RETURNING ${AGENT_COLUMNS}`,
      )
      .get(...params, agentId) as Record<string, unknown> | undefined;
    if (!row) throw new AgentNotFoundError(agentId);
    return toAgent(row);
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AgentNameTakenError((input.name ?? "").trim());
    throw err;
  }
}

export function updateAgentStatus(
  db: PolymerDatabase,
  agentId: string,
  status: string,
): Agent {
  if (!isAgentStatus(status)) throw new InvalidAgentStatusError(status);
  const row = db
    .prepare(
      `UPDATE agents SET status = ? WHERE agent_id = ?
       RETURNING agent_id, name, role, parent_agent_id, status,
                 heartbeat_timeout_seconds, last_seen, connected_at, created_at`,
    )
    .get(status, agentId) as Record<string, unknown> | undefined;
  if (!row) throw new AgentNotFoundError(agentId);
  return toAgent(row);
}

export function heartbeatAgent(
  db: PolymerDatabase,
  agentId: string,
  nowIso: string = new Date().toISOString(),
): Agent {
  const row = db
    .prepare(
      `UPDATE agents SET last_seen = ? WHERE agent_id = ?
       RETURNING agent_id, name, role, parent_agent_id, status,
                 heartbeat_timeout_seconds, last_seen, connected_at, created_at`,
    )
    .get(nowIso, agentId) as Record<string, unknown> | undefined;
  if (!row) throw new AgentNotFoundError(agentId);
  return toAgent(row);
}
