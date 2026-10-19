/**
 * Fixed-window rate limiter: a per-key bucket plus an optional
 * server-global bucket. The bucket is consumed BEFORE any lookup or
 * comparison. One instance lives per server process; tests construct
 * their own instances.
 */
class FixedWindowLimiter {
  private readonly perKey = new Map<
    string,
    { windowStart: number; count: number }
  >();
  private globalWindowStart = 0;
  private globalCount = 0;

  constructor(
    private readonly perKeyLimit: number,
    private readonly globalLimit: number,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one unit of budget. Returns false when rate-limited.
   *
   * Keys whose window has fully elapsed are dead state — keeping them
   * only serves denial-of-memory — so when the map grows past a
   * threshold (many distinct IPs/agents), expired keys are pruned
   * opportunistically on the next new key. */
  private pruneIfWorthwhile(t: number): void {
    if (this.perKey.size < 10_000) return;
    for (const [key, slot] of this.perKey) {
      if (t - slot.windowStart >= this.windowMs) this.perKey.delete(key);
    }
  }

  consume(key: string): boolean {
    const t = this.now();
    if (t - this.globalWindowStart >= this.windowMs) {
      this.globalWindowStart = t;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.globalLimit) return false;
    const slot = this.perKey.get(key);
    if (slot === undefined || t - slot.windowStart >= this.windowMs) {
      this.pruneIfWorthwhile(t);
      this.perKey.set(key, { windowStart: t, count: 1 });
    } else {
      if (slot.count >= this.perKeyLimit) return false;
      slot.count += 1;
    }
    this.globalCount += 1;
    return true;
  }
}

/**
 * Component 7: init-token verification budget — 10 req/min per IP
 * plus a server-global cap of 60/min. Consumed BEFORE any token
 * lookup or compare.
 */
export class InitVerifyLimiter extends FixedWindowLimiter {
  constructor(
    perKeyLimit: number = 10,
    globalLimit: number = 60,
    windowMs: number = 60_000,
    now: () => number = Date.now,
  ) {
    super(perKeyLimit, globalLimit, windowMs, now);
  }
}

/**
 * Component 9: reconnect refresh budget — 5 req/min per credential
 * plus a server-global cap of 60/min. The per-key slot is keyed by the
 * credential's public-id prefix (not by IP). Extends FixedWindowLimiter
 * directly so changes to the OTP-verify budget never silently move the
 * refresh budget.
 */
export class RefreshLimiter extends FixedWindowLimiter {
  constructor(windowMs = 60_000, now: () => number = Date.now) {
    super(5, 60, windowMs, now);
  }
}

/**
 * MCP request budget — 100 req/min per key (design default). The same
 * limiter keys authenticated requests by agent id and the
 * unauthenticated `initialize` handshake by source IP, so session
 * creation cannot be spammed. No server-global bucket: total session
 * growth is bounded by the server's session cap instead.
 */
export class McpLimiter extends FixedWindowLimiter {
  constructor(
    perKeyLimit: number = 100,
    windowMs = 60_000,
    now: () => number = Date.now,
  ) {
    super(perKeyLimit, Number.POSITIVE_INFINITY, windowMs, now);
  }
}

/**
 * Component 19: login (and rotate-master) budgets, "brutally": 5
 * req/min per IP plus a server-global 30/min. Consumed BEFORE the
 * master credential is touched, so attackers cannot probe faster than
 * the bucket allows.
 */
export class LoginLimiter extends FixedWindowLimiter {
  constructor(windowMs = 60_000, now: () => number = Date.now) {
    super(5, 30, windowMs, now);
  }
}

/**
 * Component 19: general administrator operations budget, 10 req/min
 * per administrator session (init-token mint sits under this
 * budget by the design's rate-limiting table).
 */
export class AdminOpsLimiter extends FixedWindowLimiter {
  constructor(windowMs = 60_000, now: () => number = Date.now) {
    super(10, Number.POSITIVE_INFINITY, windowMs, now);
  }
}

/** True when an IPv4 address falls inside a CIDR range. */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) return ip === cidr;
  const base = cidr.slice(0, slash);
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s: string): number | null => {
    const parts = s.split(".");
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      if (!/^\d+$/.test(p)) return null;
      const v = Number(p);
      if (v < 0 || v > 255) return null;
      n = (n << 8) | v;
    }
    return n >>> 0;
  };
  const ipInt = toInt(ip);
  const baseInt = toInt(base);
  if (ipInt === null || baseInt === null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function isTrustedAddress(ip: string, trusted: string[]): boolean {
  const norm = ip.trim().toLowerCase();
  for (const entry of trusted) {
    const t = entry.trim().toLowerCase();
    if (t === norm) return true;
    if (t.includes("/") && ipv4InCidr(norm, t)) return true;
  }
  return false;
}

/**
 * Resolve the rate-limit key IP for a request.
 *
 * Default: the socket remote address. When `trustedProxies` (explicit
 * CIDR/IP list) is configured, walk `X-Forwarded-For` right-to-left
 * and return the rightmost entry outside the trusted ranges. The
 * leftmost entry is never trusted (spoofable). Falls back to the
 * socket address when no usable entry exists.
 */
export function resolveRateLimitIp(
  socketIp: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: string[] = [],
): string {
  const fallback = socketIp ?? "unknown";
  if (trustedProxies.length === 0 || forwardedFor === undefined)
    return fallback;
  const raw = Array.isArray(forwardedFor)
    ? forwardedFor.join(",")
    : forwardedFor;
  const chain = raw
    .split(",")
    .map((s) => s.trim().replace(/^\[|\]$/g, ""))
    .filter((s) => s.length > 0);
  if (chain.length === 0) return fallback;
  // The socket peer must itself be trusted before XFF is consulted.
  if (!isTrustedAddress(fallback, trustedProxies)) return fallback;
  for (let i = chain.length - 1; i >= 0; i--) {
    const entry = chain[i]!;
    if (!isTrustedAddress(entry, trustedProxies)) return entry;
  }
  return fallback;
}
