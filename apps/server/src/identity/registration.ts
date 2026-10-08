import { createAgent } from "./agents.js";
import {
  RECONNECT_TTL_MS,
  SESSION_TTL_MS,
  mintCredential,
  verifyScrypt,
} from "./credentials.js";
import type { PolymerDatabase } from "../database/db.js";

export interface RegisterAgentInput {
  initTokenId: string;
  initToken: string;
  name: string;
  role: string;
  heartbeatTimeoutSeconds?: number;
}

export interface RegisterAgentOutput {
  agent_id: string;
  session_token: string;
  reconnect_secret: string;
  expires_in: number;
  reconnect_expires_in: number;
}

export class RegistrationError extends Error {
  constructor(
    readonly code:
      | "invalid_token"
      | "token_expired"
      | "token_already_used"
      | "name_taken"
      | "rate_limit_exceeded",
    readonly retryAfter?: number,
  ) {
    super(code);
    this.name = "RegistrationError";
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

/**
 * Component 7: init-token -> agent registration, one transaction.
 * Rate-limit bucket is consumed BEFORE any token lookup or compare.
 * A failed OTP guess never consumes the token.
 */
export function registerAgent(
  db: PolymerDatabase,
  input: RegisterAgentInput,
): RegisterAgentOutput {
  const row = db
    .prepare("SELECT * FROM credentials WHERE credential_id = ?")
    .get(input.initTokenId) as Record<string, unknown> | undefined;
  if (row === undefined || row["type"] !== "init") {
    throw new RegistrationError("invalid_token");
  }
  if (row["status"] !== "active") {
    throw new RegistrationError("token_already_used");
  }
  const expiresAt = row["expires_at"] as string | null;
  if (expiresAt !== null && Date.now() >= Date.parse(expiresAt)) {
    throw new RegistrationError("token_expired");
  }
  if (!verifyScrypt(input.initToken, row["token_hash"] as string)) {
    throw new RegistrationError("invalid_token");
  }

  const txn = db.transaction((): RegisterAgentOutput => {
    const consumed = db
      .prepare(
        "UPDATE credentials SET status = 'used' WHERE credential_id = ? AND status = 'active'",
      )
      .run(input.initTokenId);
    if (consumed.changes !== 1) {
      throw new RegistrationError("token_already_used");
    }
    let agentId: string;
    try {
      const agent = createAgent(db, {
        name: input.name,
        role: input.role,
        heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds,
      });
      agentId = agent.agent_id;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "name_taken"
      ) {
        throw new RegistrationError("name_taken");
      }
      throw err;
    }
    const now = Date.now();
    const session = mintCredential(db, {
      type: "agent_session",
      agentId,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    const reconnect = mintCredential(db, {
      type: "agent_reconnect",
      agentId,
      expiresAt: new Date(now + RECONNECT_TTL_MS).toISOString(),
    });
    return {
      agent_id: agentId,
      session_token: session.secret,
      reconnect_secret: reconnect.secret,
      expires_in: SESSION_TTL_MS / 1000,
      reconnect_expires_in: RECONNECT_TTL_MS / 1000,
    };
  });
  try {
    return txn();
  } catch (err) {
    if (err instanceof RegistrationError) throw err;
    if (isUniqueViolation(err)) throw new RegistrationError("name_taken");
    throw err;
  }
}

export interface RegisterSubagentInput {
  name: string;
  role: string;
  heartbeatTimeoutSeconds?: number;
}

export interface RegisterSubagentOutput {
  agent_id: string;
  parent_agent_id: string;
  session_token: string;
  reconnect_secret: string;
  expires_in: number;
  reconnect_expires_in: number;
}

/**
 * Any authenticated session holder may spawn a subagent.
 * The server sets parent_agent_id to the caller; caller-supplied
 * parents are impossible (no such input field).
 */
export function registerSubagent(
  db: PolymerDatabase,
  callerAgentId: string,
  input: RegisterSubagentInput,
): RegisterSubagentOutput {
  const caller = db
    .prepare("SELECT agent_id FROM agents WHERE agent_id = ?")
    .get(callerAgentId) as { agent_id: string } | undefined;
  if (!caller) throw new Error("unknown caller agent");
  const txn = db.transaction((): RegisterSubagentOutput => {
    let childId: string;
    try {
      const child = createAgent(db, {
        name: input.name,
        role: input.role,
        parentAgentId: callerAgentId,
        heartbeatTimeoutSeconds: input.heartbeatTimeoutSeconds,
      });
      childId = child.agent_id;
    } catch (err) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === "name_taken"
      ) {
        throw new RegistrationError("name_taken");
      }
      throw err;
    }
    const now = Date.now();
    const session = mintCredential(db, {
      type: "agent_session",
      agentId: childId,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    const reconnect = mintCredential(db, {
      type: "agent_reconnect",
      agentId: childId,
      expiresAt: new Date(now + RECONNECT_TTL_MS).toISOString(),
    });
    return {
      agent_id: childId,
      parent_agent_id: callerAgentId,
      session_token: session.secret,
      reconnect_secret: reconnect.secret,
      expires_in: SESSION_TTL_MS / 1000,
      reconnect_expires_in: RECONNECT_TTL_MS / 1000,
    };
  });
  try {
    return txn();
  } catch (err) {
    if (err instanceof RegistrationError) throw err;
    if (isUniqueViolation(err)) throw new RegistrationError("name_taken");
    throw err;
  }
}
