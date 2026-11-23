import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { listen } from "../http/server.js";
import { MCP_PATH } from "../mcp/index.js";
import { callerAgentId } from "../mcp/shared.js";
import { bootstrapMaster, mintCredential } from "../identity/credentials.js";
import {
  logSecurityEvent,
  resetSecurityLogThrottle,
} from "../identity/security-log.js";
import { tempDbPath, type App } from "./test-support.js";

const FAKE_MASTER = "FAKE-MASTER-SECRET-9f3a";
const FAKE_OTP = "FAKE-OTP-424242";
const FAKE_BEARER = "fakepub.FAKE-SESSION-SECRET";
const FAKE_CSRF = "FAKE-CSRF";
const EVENTS = new Set([
  "login_failed",
  "otp_failed",
  "init_token_already_used",
  "reconnect_already_used",
]);

let lines: string[];
beforeEach(() => {
  resetSecurityLogThrottle();
  lines = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function events(): Record<string, unknown>[] {
  return lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => EVENTS.has(e["event"] as string));
}
const keys = (e: Record<string, unknown>): string[] => Object.keys(e).sort();

function login(
  app: App,
  master: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${app.url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ master_credential: master }),
  });
}

async function mcp(app: App): Promise<Client> {
  const c = new Client({ name: "t", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${app.url}${MCP_PATH}`)),
  );
  return c;
}

const reg = (c: Client, id: string, token: string) =>
  c.callTool({
    name: "register_agent",
    arguments: { init_token_id: id, init_token: token, name: "a1", role: "r" },
  });

describe("security events (#151)", () => {
  it("login: rejected for wrong/blank/missing credential, then rate_limited, exact keys", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-seclog-"),
    });
    try {
      bootstrapMaster(app.db!);
      await login(app, FAKE_MASTER);
      await login(app, "");
      await login(app, undefined);
      let limited = 0;
      for (let i = 0; i < 4; i++) {
        if ((await login(app, FAKE_MASTER)).status === 429) limited++;
      }
      expect(limited).toBeGreaterThan(0);
      const ev = events();
      const rej = ev.filter((e) => e["outcome"] === "rejected");
      expect(rej).toHaveLength(5);
      for (const e of rej) {
        expect(keys(e)).toEqual(["at", "event", "ip", "outcome"]);
        expect(e["event"]).toBe("login_failed");
        expect(e["ip"]).toBe("127.0.0.1");
        expect(Number.isNaN(Date.parse(e["at"] as string))).toBe(false);
      }
      const rl = ev.filter((e) => e["outcome"] === "rate_limited");
      expect(rl).toHaveLength(1); // throttled: 1 per event name per window
      expect(keys(rl[0]!)).toEqual(["at", "event", "ip", "outcome"]);
    } finally {
      await app.close();
    }
  });

  it("logged ip is the trusted-proxy-aware client ip, capped at 64 chars, one line per event", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-seclog-"),
      trustedProxies: ["127.0.0.1"],
    });
    try {
      await login(app, FAKE_MASTER, { "x-forwarded-for": "203.0.113.9" });
      expect(events()[0]!["ip"]).toBe("203.0.113.9");
      const evil = `"}{"event":"forged"}\\n${"a".repeat(200)}`;
      await login(app, FAKE_MASTER, { "x-forwarded-for": evil });
      const last = events().at(-1)!;
      expect((last["ip"] as string).length).toBe(64);
      expect(lines.every((l) => !l.includes("\n"))).toBe(true);
      expect(events().some((e) => e["event"] === "forged")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("an untrusted peer's spoofed XFF is ignored: ip is the socket peer", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-seclog-"),
    });
    try {
      await login(app, FAKE_MASTER, { "x-forwarded-for": "203.0.113.9" });
      expect(events()[0]!["ip"]).toBe("127.0.0.1");
    } finally {
      await app.close();
    }
  });

  it("otp: wrong code and unknown id are identical and id-free; replay logs credential_id only; budget exhaustion is rate_limited", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-seclog-"),
    });
    const c = await mcp(app);
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const unknownId = "00000000-0000-4000-8000-00000000dead";
      expect((await reg(c, credential.credential_id, FAKE_OTP)).isError).toBe(
        true,
      );
      expect((await reg(c, unknownId, FAKE_OTP)).isError).toBe(true);
      let ev = events();
      expect(ev).toHaveLength(2);
      for (const e of ev) {
        expect(keys(e)).toEqual(["at", "event", "ip", "outcome"]);
        expect(e["event"]).toBe("otp_failed");
        expect(e["outcome"]).toBe("rejected");
        expect(e["ip"]).toBe("127.0.0.1");
      }
      const text = lines.join("\n");
      expect(text).not.toContain(credential.credential_id);
      expect(text).not.toContain(unknownId);
      expect(text).not.toContain(FAKE_OTP);

      const ok = await reg(c, credential.credential_id, secret);
      expect(ok.isError).toBeFalsy();
      lines.length = 0;
      expect((await reg(c, credential.credential_id, secret)).isError).toBe(
        true,
      );
      ev = events();
      expect(ev).toHaveLength(1);
      expect(keys(ev[0]!)).toEqual(["at", "credential_id", "event", "ip"]);
      expect(ev[0]!["event"]).toBe("init_token_already_used");
      expect(ev[0]!["credential_id"]).toBe(credential.credential_id);
      expect(lines.join("\n")).not.toContain(secret);

      lines.length = 0;
      for (let i = 0; i < 12; i++) {
        await reg(c, unknownId, FAKE_OTP).catch(() => undefined);
      }
      const rl = events().filter((e) => e["outcome"] === "rate_limited");
      expect(rl).toHaveLength(1);
      expect(keys(rl[0]!)).toEqual(["at", "event", "ip", "outcome"]);
      expect(rl[0]!["event"]).toBe("otp_failed");
    } finally {
      await c.close();
      await app.close();
    }
  });

  it("never logs secret material, across every event", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-seclog-"),
    });
    const c = await mcp(app);
    try {
      await login(app, FAKE_MASTER, {
        authorization: `Bearer ${FAKE_BEARER}`,
        "x-csrf-token": FAKE_CSRF,
      });
      await reg(c, FAKE_BEARER, FAKE_OTP).catch(() => undefined);
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      await reg(c, credential.credential_id, secret);
      await reg(c, credential.credential_id, FAKE_OTP).catch(() => undefined);
      expect(events().length).toBeGreaterThanOrEqual(3);
      const text = lines.join("\n");
      for (const s of [
        FAKE_MASTER,
        FAKE_OTP,
        FAKE_BEARER,
        FAKE_CSRF,
        secret,
        "token_hash",
        "scrypt$",
      ]) {
        expect(text).not.toContain(s);
      }
    } finally {
      await c.close();
      await app.close();
    }
  });
});

describe("security-log helper", () => {
  it("throttles rate_limited per event name, reports suppressed, never throttles rejected", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 50; i++) {
      logSecurityEvent("login_failed", {
        outcome: "rate_limited",
        ip: "1.1.1.1",
      });
    }
    logSecurityEvent("otp_failed", { outcome: "rate_limited", ip: "2.2.2.2" });
    logSecurityEvent("login_failed", { outcome: "rejected", ip: "1.1.1.1" });
    logSecurityEvent("login_failed", { outcome: "rejected", ip: "1.1.1.1" });
    expect(events()).toHaveLength(4);
    vi.advanceTimersByTime(60_000);
    logSecurityEvent("login_failed", {
      outcome: "rate_limited",
      ip: "9.9.9.9",
    });
    expect(events().at(-1)!["suppressed"]).toBe(49);
  });
});

describe("identity never comes from the unauthenticated request context", () => {
  it("callerAgentId ignores extra.clientIp and an unauthenticated authInfo", () => {
    expect(
      callerAgentId({
        authInfo: { clientId: "", extra: { clientIp: "1.2.3.4" } },
      }),
    ).toBeUndefined();
    expect(
      callerAgentId({ authInfo: { extra: { clientIp: "agent-x" } } }),
    ).toBeUndefined();
    expect(callerAgentId({ authInfo: { extra: { agentId: "a" } } })).toBe("a");
  });

  it("an unauthenticated register_agent succeeds, so it is not seen as an authenticated caller", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-seclog-"),
    });
    const c = await mcp(app);
    try {
      const { credential, secret } = mintCredential(app.db!, { type: "init" });
      const r = await reg(c, credential.credential_id, secret);
      expect(r.isError).toBeFalsy();
    } finally {
      await c.close();
      await app.close();
    }
  });
});
