import { randomUUID } from "node:crypto";
import type { PolymerDatabase } from "../database/db.js";

export const AGENT_STATUSES = [
  "connecting",
  "connected",
  "idle",
  "working",
  "error",
  "disconnected",
  "disabled",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

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

export interface CreateAgentInput {
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

export class InvalidAgentStatusError extends Error {
  readonly code = "invalid_status";
  constructor(status: string) {
    super(`invalid agent status: ${status}`);
    this.name = "InvalidAgentStatusError";
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
