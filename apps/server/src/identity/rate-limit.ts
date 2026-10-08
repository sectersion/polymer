/**
 * Fixed-window rate limiter: a per-key bucket plus an optional
 * server-global bucket. The bucket is consumed BEFORE any lookup or
 * comparison. One instance lives per server process; tests construct
 * their own instances.
 */
export class FixedWindowLimiter {
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
 * credential's public-id prefix (not by IP).
 */
export class RefreshLimiter extends InitVerifyLimiter {
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
