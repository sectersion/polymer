import { randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthenticatedPrincipal {
  agentId: string;
  /** Opaque identifier for the credential (never the secret itself). */
  tokenId: string;
  expiresAtMs: number;
}

export type VerifyFailureReason = "missing" | "invalid" | "expired";

export type VerifyResult =
  | { ok: true; principal: AuthenticatedPrincipal }
  | { ok: false; reason: VerifyFailureReason };

interface StoredCredential extends AuthenticatedPrincipal {
  /** Secret token value. Kept in memory only for the component-3 test verifier. */
  secret: string;
}

const testCredentials: StoredCredential[] = [];

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function mintTestCredential(
  agentId: string,
  ttlMs = 3_600_000,
): { token: string; principal: AuthenticatedPrincipal } {
  const token = `poly_test_${randomBytes(32).toString("hex")}`;
  const principal: AuthenticatedPrincipal = {
    agentId,
    tokenId: randomBytes(8).toString("hex"),
    expiresAtMs: Date.now() + ttlMs,
  };
  testCredentials.push({ ...principal, secret: token });
  return { token, principal };
}

export function clearTestCredentials(): void {
  testCredentials.length = 0;
}

export function extractBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

export function verifyTestCredential(
  token: string | undefined,
): VerifyResult {
  if (!token) return { ok: false, reason: "missing" };
  const match = testCredentials.find((c) => safeEqual(c.secret, token));
  if (!match) return { ok: false, reason: "invalid" };
  if (Date.now() >= match.expiresAtMs) return { ok: false, reason: "expired" };
  const principal: AuthenticatedPrincipal = {
    agentId: match.agentId,
    tokenId: match.tokenId,
    expiresAtMs: match.expiresAtMs,
  };
  return { ok: true, principal };
}
