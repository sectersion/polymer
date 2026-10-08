import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  openDatabase,
  type PolymerDatabase,
} from "../database/db.js";
import {
  generateInitOtp,
  generateMachineSecret,
  getCredentialById,
  getCredentialByPublicId,
  mintCredential,
  revokeCredential,
  scryptHash,
  sha256Hex,
  verifyCredential,
  verifyScrypt,
} from "../identity/credentials.js";

const openHandles: PolymerDatabase[] = [];

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-creds-")), "test.db");
}

afterEach(() => {
  while (openHandles.length > 0) closeDatabase(openHandles.pop()!);
});

function openTestDb(): PolymerDatabase {
  const db = openDatabase(tempDbPath());
  openHandles.push(db);
  return db;
}

describe("Credential storage (component 6)", () => {
  it("machine secrets have 256-bit entropy and SHA-256 hashes", () => {
    const a = generateMachineSecret();
    const b = generateMachineSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("init OTPs are zero-padded 6-digit CSPRNG codes", () => {
    for (let i = 0; i < 25; i++) {
      expect(generateInitOtp()).toMatch(/^\d{6}$/);
    }
  });

  it("minted init OTPs expire by default (auth.initTokenExpiry: 600)", () => {
    const db = openTestDb();
    const before = Date.now();
    const init = mintCredential(db, { type: "init" });
    const session = mintCredential(db, { type: "agent_session" });
    // Init tokens live 10 minutes by default; other credential types
    // are not born expiry-bound.
    const deltaSeconds =
      (Date.parse(init.credential.expires_at!) - before) / 1000;
    expect(deltaSeconds).toBeGreaterThanOrEqual(599);
    expect(deltaSeconds).toBeLessThanOrEqual(601);
    expect(session.credential.expires_at).toBeNull();
  });

  it("init and master rows store scrypt/PHC, machine rows store SHA-256", () => {
    const db = openTestDb();
    const init = mintCredential(db, { type: "init" });
    const master = mintCredential(db, {
      type: "master",
      secret: "human-chosen-password",
    });
    const session = mintCredential(db, { type: "agent_session" });
    expect(init.credential.token_hash.startsWith("$scrypt$")).toBe(true);
    expect(master.credential.token_hash.startsWith("$scrypt$")).toBe(true);
    expect(session.credential.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      verifyScrypt("human-chosen-password", master.credential.token_hash),
    ).toBe(true);
  });

  it("never persists the plaintext secret", () => {
    const db = openTestDb();
    const { credential, secret } = mintCredential(db, {
      type: "agent_session",
    });
    const row = getCredentialById(db, credential.credential_id)!;
    expect(row.token_hash).not.toContain(secret);
    expect(row.token_hash).toBe(sha256Hex(secret));
    const dump = JSON.stringify(db.prepare("SELECT * FROM credentials").all());
    expect(dump).not.toContain(secret);
  });

  it("correct secret authenticates; wrong secret does not", () => {
    const db = openTestDb();
    const { credential, secret } = mintCredential(db, {
      type: "agent_session",
    });
    expect(verifyCredential(db, credential.credential_id, secret).ok).toBe(
      true,
    );
    expect(
      verifyCredential(db, credential.credential_id, "wrong-secret").ok,
    ).toBe(false);
    expect(
      verifyCredential(db, "00000000-0000-4000-8000-000000000000", secret),
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("expired and revoked secrets do not authenticate", () => {
    const db = openTestDb();
    const expired = mintCredential(db, {
      type: "agent_session",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    expect(
      verifyCredential(db, expired.credential.credential_id, expired.secret),
    ).toEqual({ ok: false, reason: "expired" });
    const { credential, secret } = mintCredential(db, {
      type: "agent_session",
    });
    revokeCredential(db, credential.credential_id);
    expect(verifyCredential(db, credential.credential_id, secret)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  it("hash lookup works via public_id; init rows have no prefix", () => {
    const db = openTestDb();
    const session = mintCredential(db, { type: "agent_session" });
    expect(session.credential.public_id).not.toBeNull();
    expect(
      getCredentialByPublicId(db, session.credential.public_id!)?.credential_id,
    ).toBe(session.credential.credential_id);
    const init = mintCredential(db, { type: "init" });
    expect(init.credential.public_id).toBeNull();
    expect(getCredentialById(db, init.credential.credential_id)).toBeDefined();
  });

  it("scrypt uses per-token salts and never logs secrets", () => {
    const db = openTestDb();
    const h1 = scryptHash("same-secret");
    const h2 = scryptHash("same-secret");
    expect(h1).not.toBe(h2);
    // Capture all real console output across mint + verify: no secret may
    // appear on any logging path (module has no logger by construction).
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((m) => console[m]);
    const captured: string[] = [];
    const spy = (...args: unknown[]): void => {
      captured.push(
        args
          .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
          .join(" "),
      );
    };
    for (const m of methods) {
      (console[m] as unknown) = spy;
    }
    try {
      const { credential, secret } = mintCredential(db, {
        type: "agent_session",
      });
      verifyCredential(db, credential.credential_id, secret);
      verifyCredential(db, credential.credential_id, "wrong");
      expect(captured.join("\n")).not.toContain(secret);
      expect(credential.token_hash).not.toContain(secret);
    } finally {
      methods.forEach((m, i) => {
        console[m] = originals[i]!;
      });
    }
  });
});
