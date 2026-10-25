import { describe, expect, it } from "vitest";
import {
  AdminOpsLimiter,
  InitVerifyLimiter,
  LoginLimiter,
  McpLimiter,
  RefreshLimiter,
  resolveRateLimitIp,
} from "../identity/rate-limit.js";

describe("fixed-window limiter mechanics (audit #27)", () => {
  it("a per-key bucket refills only after the full window elapses", () => {
    let now = 0;
    const limiter = new InitVerifyLimiter(3, 1000, 1000, () => now);
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.consume("ip-1")).toBe(true);
    }
    // Fourth unit inside the window: rejected.
    expect(limiter.consume("ip-1")).toBe(false);
    // 999ms in: still the same window.
    now = 999;
    expect(limiter.consume("ip-1")).toBe(false);
    // Window fully elapsed: refill.
    now = 1000;
    expect(limiter.consume("ip-1")).toBe(true);
  });

  it("keys are isolated: exhausting one bucket never touches another", () => {
    let now = 0;
    const limiter = new InitVerifyLimiter(2, 1000, 1000, () => now);
    expect(limiter.consume("ip-a")).toBe(true);
    expect(limiter.consume("ip-a")).toBe(true);
    expect(limiter.consume("ip-a")).toBe(false);
    expect(limiter.consume("ip-b")).toBe(true);
    now += 1000;
    expect(limiter.consume("ip-b")).toBe(true); // refill follows per key
  });

  it("a rejected per-key consume burns NO global budget (distinct keys still admitted)", () => {
    const now = 0;
    // per-key 2, global 3: two consumes fill key a and leave exactly
    // one global unit; the third consume of a is per-key-rejected, and
    // a fresh key must still be admitted afterwards.
    const limiter = new InitVerifyLimiter(2, 3, 1000, () => now);
    expect(limiter.consume("ip-a")).toBe(true);
    expect(limiter.consume("ip-a")).toBe(true);
    expect(limiter.consume("ip-a")).toBe(false); // per-key reject
    expect(limiter.consume("ip-b")).toBe(true);
  });

  it("the global cap applies before any per-key accounting", () => {
    let now = 0;
    // Per-key limit never reached; global exhausts first.
    const limiter = new InitVerifyLimiter(10, 3, 1000, () => now);
    expect(limiter.consume("ip-a")).toBe(true);
    expect(limiter.consume("ip-b")).toBe(true);
    expect(limiter.consume("ip-c")).toBe(true);
    const blocked = limiter.consume("ip-d");
    expect(blocked).toBe(false); // rejected WITHOUT creating the slot
    now = 1000;
    expect(limiter.consume("ip-d")).toBe(true);
  });

  it("the server-global window resets on elapse even under steady traffic", () => {
    let now = 0;
    const limiter = new RefreshLimiter(500, () => now); // per-key 5, global 60
    // Burn the global window entirely.
    for (let i = 0; i < 60; i += 1) {
      expect(limiter.consume(`cred-${i}`)).toBe(true);
    }
    expect(limiter.consume("cred-overflow")).toBe(false);
    now = 60_000;
    expect(limiter.consume("cred-again")).toBe(true);
  });

  it("each limiter ships its documented budgets", () => {
    let now = 0;
    const login = new LoginLimiter(60_000, () => now);
    for (let i = 0; i < 5; i += 1) expect(login.consume("ip")).toBe(true);
    expect(login.consume("ip")).toBe(false);
    for (let i = 0; i < 25; i += 1) expect(login.consume(`ip-${i}`)).toBe(true);
    expect(login.consume("ip-final")).toBe(false); // global 30

    now = 60_000;
    const mcp = new McpLimiter(7, 60_000, () => now);
    for (let i = 0; i < 7; i += 1) expect(mcp.consume("agent-1")).toBe(true);
    expect(mcp.consume("agent-1")).toBe(false);

    const ops = new AdminOpsLimiter(60_000, () => now);
    for (let i = 0; i < 10; i += 1) expect(ops.consume("admin")).toBe(true);
    expect(ops.consume("admin")).toBe(false); // no global bucket: other keys live
    expect(ops.consume("admin-2")).toBe(true);
  });
});

describe("resolveRateLimitIp: XFF trust (audit #27)", () => {
  it("no trusted proxies: XFF is never consulted, even when present", () => {
    expect(resolveRateLimitIp("10.0.0.9", "1.2.3.4", [])).toBe("10.0.0.9");
  });

  it("no XFF (or an empty chain): the socket address stands", () => {
    expect(resolveRateLimitIp("10.0.0.9", undefined, ["127.0.0.1"])).toBe(
      "10.0.0.9",
    );
    expect(resolveRateLimitIp("10.0.0.9", " , , ", ["10.0.0.0/8"])).toBe(
      "10.0.0.9",
    );
    expect(resolveRateLimitIp(undefined, "1.2.3.4", ["127.0.0.1"])).toBe(
      "unknown",
    );
  });

  it("an untrusted socket peer: spoofable XFF is ignored", () => {
    // The attacker's XFF header never replaces the socket address.
    expect(resolveRateLimitIp("203.0.113.7", "9.9.9.9", ["10.0.0.0/8"])).toBe(
      "203.0.113.7",
    );
  });

  it("trusted proxy: the rightmost untrusted entry wins", () => {
    expect(
      resolveRateLimitIp(
        "10.0.0.2", // the proxy
        "6.6.6.6, 10.0.0.2", // leftmost is the client claim; only the rightmost untrusted entry may win
        ["10.0.0.0/8"],
      ),
    ).toBe("6.6.6.6");
    expect(
      resolveRateLimitIp("10.0.0.2", "1.1.1.1, 6.6.6.6, 10.0.0.2", [
        "10.0.0.0/8",
      ]),
    ).toBe("6.6.6.6");
  });

  it("all entries trusted (nested proxies): back to the socket address", () => {
    expect(
      resolveRateLimitIp("10.0.0.2", "10.0.0.44, 10.0.0.3", ["10.0.0.0/8"]),
    ).toBe("10.0.0.2");
  });

  it("array-form headers and bracketed IPv6 normalize to the same key", () => {
    expect(
      resolveRateLimitIp(
        "127.0.0.1",
        [" 1.1.1.1 ", "88.44.22.11"],
        ["127.0.0.1"],
      ),
    ).toBe("88.44.22.11");
    expect(resolveRateLimitIp("::1", "[::1], 81.44.27.11", ["::1"])).toBe(
      "81.44.27.11",
    );
  });

  it("case and whitespace in trusted entries do not matter", () => {
    expect(
      resolveRateLimitIp("10.0.0.2", "77.1.2.3", [" 10.0.0.0/8 ", "Foo"]),
    ).toBe("77.1.2.3");
  });

  it("exact-IP entries (no slash) match by equality only", () => {
    expect(resolveRateLimitIp("10.0.0.2", "77.1.2.3", ["10.0.0.2"])).toBe(
      "77.1.2.3",
    );
    expect(resolveRateLimitIp("10.0.0.99", undefined)).toBe("10.0.0.99");
  });

  it("CIDR matching is by IPv4 math: edge of the prefix matches, off-prefix does not", () => {
    expect(resolveRateLimitIp("10.255.255.7", "88.1.1.1", ["10.0.0.0/8"])).toBe(
      "88.1.1.1", // socket inside /8 → XFF consulted
    );
    expect(resolveRateLimitIp("10.0.1.7", undefined, ["10.0.0.7"])).toBe(
      "10.0.1.7",
    );
    // A /0 entry trusts every IPv4 address — the socket AND the whole
    // chain — so the fallback stands by construction.
    expect(resolveRateLimitIp("9.9.9.9", "77.1.1.1", ["0.0.0.0/0"])).toBe(
      "9.9.9.9",
    );
    // A narrower prefix trusts only the socket, not the chain entry.
    expect(resolveRateLimitIp("9.9.9.9", "77.1.1.1", ["9.9.0.0/16"])).toBe(
      "77.1.1.1",
    );
  });

  it("malformed trusted configuration matches nothing malicious", () => {
    // Out-of-range CIDR bits and unparseable octets refuse to match.
    expect(
      resolveRateLimitIp("10.0.0.9", "77.1.1.1", ["10.0.0.0/33", "abc"]),
    ).toBe("10.0.0.9");
    expect(
      resolveRateLimitIp("10.0.0.9", "77.1.1.1", ["10.0.0.0/-1", "1.2.3"]),
    ).toBe("10.0.0.9");
    expect(resolveRateLimitIp("1.2.3", undefined)).toBe("1.2.3");
  });
});
