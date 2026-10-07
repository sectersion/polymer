/**
 * Component 7: fixed-window rate limiter for init-token verification.
 *
 * OTP verify budget: 10 req/min per IP plus a server-global cap of
 * 60/min. The bucket is consumed BEFORE any token lookup or compare.
 * One instance lives per server (the "global" cap is per server
 * process); tests construct their own instances.
 */
export class InitVerifyLimiter {
  private readonly perIp = new Map<
    string,
    { windowStart: number; count: number }
  >();
  private globalWindowStart = 0;
  private globalCount = 0;

  constructor(
    private readonly perIpLimit: number = 10,
    private readonly globalLimit: number = 60,
    private readonly windowMs: number = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one unit of budget. Returns false when rate-limited. */
  consume(ip: string): boolean {
    const t = this.now();
    if (t - this.globalWindowStart >= this.windowMs) {
      this.globalWindowStart = t;
      this.globalCount = 0;
    }
    if (this.globalCount >= this.globalLimit) return false;
    const slot = this.perIp.get(ip);
    if (slot === undefined || t - slot.windowStart >= this.windowMs) {
      this.perIp.set(ip, { windowStart: t, count: 1 });
    } else {
      if (slot.count >= this.perIpLimit) return false;
      slot.count += 1;
    }
    this.globalCount += 1;
    return true;
  }
}
