import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { PolymerDatabase } from "./db.js";

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
  const secret =
    input.secret ??
    (input.type === "init" ? generateInitOtp() : generateMachineSecret());
  const tokenHash = hashForType(input.type, secret);
  const credentialId = randomUUID();
  const publicId =
    input.publicId ??
    (input.type === "init" ? null : randomBytes(8).toString("hex"));
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
