import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { PolymerDatabase } from "../database/db.js";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RECONNECT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const CREDENTIAL_TYPES = [
  "master",
  "init",
  "agent_session",
  "agent_reconnect",
  "admin_session",
] as const;

export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

export interface Credential {
  credential_id: string;
  public_id: string | null;
  type: CredentialType;
  token_hash: string;
  agent_id: string | null;
  status: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  rotated_from_credential_id: string | null;
}

export interface MintCredentialInput {
  type: CredentialType;
  /** Plaintext secret. Generated when omitted (machine types + init OTP). */
  secret?: string;
  publicId?: string | null;
  agentId?: string | null;
  expiresAt?: string | null;
}

/** 256-bit machine secret, hex-encoded. */
export function generateMachineSecret(): string {
  return randomBytes(32).toString("hex");
}

/** 6-digit init OTP from a CSPRNG, zero-padded (~20 bits). */
export function generateInitOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function sha256Hex(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, keyLen: 32 } as const;

/** scrypt PHC-style string: $scrypt$N=..,r=..,p=..$<b64 salt>$<b64 hash>. */
export function scryptHash(secret: string, salt?: Buffer): string {
  const saltBuf = salt ?? randomBytes(16);
  const derived = scryptSync(secret, saltBuf, SCRYPT_OPTS.keyLen, {
    N: SCRYPT_OPTS.N,
    r: SCRYPT_OPTS.r,
    p: SCRYPT_OPTS.p,
  });
  const params = `N=${SCRYPT_OPTS.N},r=${SCRYPT_OPTS.r},p=${SCRYPT_OPTS.p}`;
  return `$scrypt$${params}$${saltBuf.toString("base64")}$${(
    derived as Buffer
  ).toString("base64")}`;
}

export function verifyScrypt(secret: string, phc: string): boolean {
  const parts = phc.split("$");
  if (parts.length !== 5 || parts[1] !== "scrypt") return false;
  const params = parts[2] ?? "";
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(params);
  if (!m) return false;
  try {
    const salt = Buffer.from(parts[3] ?? "", "base64");
    const expected = Buffer.from(parts[4] ?? "", "base64");
    if (salt.length !== 16 || expected.length !== SCRYPT_OPTS.keyLen) {
      return false;
    }
    const derived = scryptSync(secret, salt, expected.length, {
      N: Number(m[1]),
      r: Number(m[2]),
      p: Number(m[3]),
    }) as Buffer;
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function isScryptPhc(value: string): boolean {
  return value.startsWith("$scrypt$");
}

function hashForType(type: CredentialType, secret: string): string {
  if (type === "init" || type === "master") return scryptHash(secret);
  return sha256Hex(secret);
}

function toCredential(row: Record<string, unknown>): Credential {
  return {
    credential_id: row["credential_id"] as string,
    public_id: (row["public_id"] as string | null) ?? null,
    type: row["type"] as CredentialType,
    token_hash: row["token_hash"] as string,
    agent_id: (row["agent_id"] as string | null) ?? null,
    status: row["status"] as string,
    created_at: row["created_at"] as string,
    expires_at: (row["expires_at"] as string | null) ?? null,
    last_used_at: (row["last_used_at"] as string | null) ?? null,
    rotated_from_credential_id:
      (row["rotated_from_credential_id"] as string | null) ?? null,
  };
}

const RETURNING = `credential_id, public_id, type, token_hash, agent_id,
  status, created_at, expires_at, last_used_at, rotated_from_credential_id`;

/**
 * Component 6: mint a credential, storing only the hash.
 * Returns the row plus the plaintext secret (once — never persisted).
 */
export function mintCredential(
  db: PolymerDatabase,
  input: MintCredentialInput,
): { credential: Credential; secret: string } {
  const rawSecret =
    input.secret ??
    (input.type === "init" ? generateInitOtp() : generateMachineSecret());
  const credentialId = randomUUID();
  const publicId =
    input.publicId ??
    (input.type === "init" ? null : randomBytes(8).toString("hex"));
  // Machine tokens carry their public lookup prefix: "<publicId>.<secret>".
  // Init OTPs stay bare 6-digit codes looked up by credential_id.
  const secret =
    publicId !== null && input.secret === undefined
      ? `${publicId}.${rawSecret}`
      : rawSecret;
  const tokenHash = hashForType(input.type, secret);
  const row = db
    .prepare(
      `INSERT INTO credentials
         (credential_id, public_id, type, token_hash, agent_id, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)
       RETURNING ${RETURNING}`,
    )
    .get(
      credentialId,
      publicId,
      input.type,
      tokenHash,
      input.agentId ?? null,
      input.expiresAt ?? null,
    ) as Record<string, unknown>;
  return { credential: toCredential(row), secret };
}

export function getCredentialById(
  db: PolymerDatabase,
  credentialId: string,
): Credential | undefined {
  const row = db
    .prepare(`SELECT ${RETURNING} FROM credentials WHERE credential_id = ?`)
    .get(credentialId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toCredential(row);
}

export function getCredentialByPublicId(
  db: PolymerDatabase,
  publicId: string,
): Credential | undefined {
  const row = db
    .prepare(`SELECT ${RETURNING} FROM credentials WHERE public_id = ?`)
    .get(publicId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toCredential(row);
}

export type VerifyFailure = "not_found" | "revoked" | "expired" | "invalid";

function constantTimeHexEqual(aHex: string, bHex: string): boolean {
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(aHex, "hex");
    b = Buffer.from(bHex, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a secret against a stored row: status, expiry, then hash compare. */
export function verifyCredential(
  db: PolymerDatabase,
  credentialId: string,
  secret: string,
): { ok: true; credential: Credential } | { ok: false; reason: VerifyFailure } {
  const cred = getCredentialById(db, credentialId);
  if (!cred) return { ok: false, reason: "not_found" };
  if (cred.status !== "active") return { ok: false, reason: "revoked" };
  if (cred.expires_at !== null && Date.now() >= Date.parse(cred.expires_at)) {
    return { ok: false, reason: "expired" };
  }
  const valid = isScryptPhc(cred.token_hash)
    ? verifyScrypt(secret, cred.token_hash)
    : constantTimeHexEqual(sha256Hex(secret), cred.token_hash);
  return valid
    ? { ok: true, credential: cred }
    : { ok: false, reason: "invalid" };
}

export function revokeCredential(
  db: PolymerDatabase,
  credentialId: string,
): Credential | undefined {
  const row = db
    .prepare(
      `UPDATE credentials SET status = 'revoked' WHERE credential_id = ?
       RETURNING ${RETURNING}`,
    )
    .get(credentialId) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : toCredential(row);
}

export interface SessionPrincipal {
  agentId: string;
  credentialId: string;
}

/**
 * Component 7: verify an agent session Bearer against the credentials
 * table. Only `agent_session` rows authenticate MCP traffic; reconnect
 * credentials (and everything else) authenticate nothing here.
 */
export function verifySessionToken(
  db: PolymerDatabase,
  token: string,
): { ok: true; principal: SessionPrincipal } | { ok: false } {
  const dot = token.indexOf(".");
  if (dot <= 0) return { ok: false };
  const cred = getCredentialByPublicId(db, token.slice(0, dot));
  if (!cred || cred.type !== "agent_session" || cred.status !== "active") {
    return { ok: false };
  }
  if (cred.expires_at !== null && Date.now() >= Date.parse(cred.expires_at)) {
    return { ok: false };
  }
  if (!constantTimeHexEqual(sha256Hex(token), cred.token_hash)) {
    return { ok: false };
  }
  if (cred.agent_id === null) return { ok: false };
  return {
    ok: true,
    principal: { agentId: cred.agent_id, credentialId: cred.credential_id },
  };
}

export class RefreshError extends Error {
  constructor(
    readonly code: "reconnect_secret_invalid" | "reconnect_already_used",
    readonly credentialId?: string,
    readonly agentId?: string,
  ) {
    super(code);
    this.name = "RefreshError";
  }
}

export interface RefreshOutput {
  agent_id: string;
  session_token: string;
  reconnect_secret: string;
  expires_in: number;
  reconnect_expires_in: number;
}

/**
 * Component 9: rotate an agent reconnect credential. The presented
 * secret must match an active, unexpired `agent_reconnect` row. On success the old row is invalidated
 * (`revoked`) and a fresh session + reconnect pair is minted for the
 * same agent, all in one transaction. Only the presented reconnect
 * row is touched; existing session rows stay valid until expiry.
 *
 * A hash-matching but non-active row means the credential was already
 * rotated: `reconnect_already_used` (replay; security event, never
 * silently restored). Anything else (unknown id, wrong type, expired,
 * hash mismatch) is `reconnect_secret_invalid`.
 */
export function refreshReconnect(
  db: PolymerDatabase,
  secret: string,
): RefreshOutput {
  const dot = secret.indexOf(".");
  if (dot <= 0) {
    throw new RefreshError("reconnect_secret_invalid");
  }
  const cred = getCredentialByPublicId(db, secret.slice(0, dot));
  if (
    !cred ||
    cred.type !== "agent_reconnect" ||
    cred.agent_id === null ||
    (cred.expires_at !== null && Date.now() >= Date.parse(cred.expires_at)) ||
    !constantTimeHexEqual(sha256Hex(secret), cred.token_hash)
  ) {
    throw new RefreshError("reconnect_secret_invalid");
  }
  if (cred.status !== "active") {
    throw new RefreshError(
      "reconnect_already_used",
      cred.credential_id,
      cred.agent_id,
    );
  }
  // Narrowed once here: property narrowing does not survive into the
  // transaction closure below.
  const agentId = cred.agent_id;
  const txn = db.transaction((): RefreshOutput => {
    const consumed = db
      .prepare(
        "UPDATE credentials SET status = 'revoked' WHERE credential_id = ? AND status = 'active'",
      )
      .run(cred.credential_id);
    if (consumed.changes !== 1) {
      // A concurrent refresh won the race; never restore the old secret.
      throw new RefreshError(
        "reconnect_already_used",
        cred.credential_id,
        agentId,
      );
    }
    const now = Date.now();
    const session = mintCredential(db, {
      type: "agent_session",
      agentId: cred.agent_id,
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    const reconnect = mintCredential(db, {
      type: "agent_reconnect",
      agentId: cred.agent_id,
      expiresAt: new Date(now + RECONNECT_TTL_MS).toISOString(),
    });
    return {
      agent_id: cred.agent_id as string,
      session_token: session.secret,
      reconnect_secret: reconnect.secret,
      expires_in: SESSION_TTL_MS / 1000,
      reconnect_expires_in: RECONNECT_TTL_MS / 1000,
    };
  });
  return txn();
}
