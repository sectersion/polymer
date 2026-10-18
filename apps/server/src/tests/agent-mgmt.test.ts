import { describe, expect, it } from "vitest";
import {
  closeDatabase,
  openDatabase,
  type PolymerDatabase,
} from "../database/db.js";
import {
  createAgent,
  listAgentsPage,
  updateAgentProfile,
} from "../identity/agents.js";
import {
  disableAgentSubtree,
  reenableAgentSubtree,
} from "../identity/disable.js";
import { bootstrapMaster } from "../identity/credentials.js";
import { listen } from "../http/server.js";
import {
  registerAgentsOn,
  tempDbPath,
  withAuthedClients,
} from "./test-support.js";

const openHandles: PolymerDatabase[] = [];

function openTestDb(): PolymerDatabase {
  const path = tempDbPath("polymer-agent-mgmt-");
  const db = openDatabase(path);
  openHandles.push(db);
  return db;
}

function closeAll(): void {
  while (openHandles.length > 0) closeDatabase(openHandles.pop()!);
}

function cookieOf(setCookie: string): string {
  const pair = setCookie.split(";")[0].trim();
  const eq = pair.indexOf("=");
  return eq === -1 ? pair : pair.slice(eq + 1).trim();
}

describe("agent management (roster, re-enable, profile)", () => {
  it("filters and paginates the roster with opaque cursors", () => {
    const db = openTestDb();
    try {
      const parent = createAgent(db, { name: "p", role: "orchestrator" });
      createAgent(db, {
        name: "c1",
        role: "coder",
        parentAgentId: parent.agent_id,
      });
      createAgent(db, {
        name: "c2",
        role: "reviewer",
        parentAgentId: parent.agent_id,
      });
      const byRole = listAgentsPage(db, { role: "coder" });
      expect(byRole.agents.map((a) => a.name)).toEqual(["c1"]);
      expect(byRole.next_cursor).toBeNull();
      const byParent = listAgentsPage(db, {
        parentAgentId: parent.agent_id,
      });
      expect(byParent.agents.map((a) => a.name)).toEqual(["c1", "c2"]);
      const first = listAgentsPage(db, { limit: 2 });
      expect(first.agents).toHaveLength(2);
      expect(typeof first.next_cursor).toBe("string");
      const second = listAgentsPage(db, {
        limit: 2,
        cursor: first.next_cursor!,
      });
      expect(second.agents.map((a) => a.name)).toEqual(["c2"]);
      expect(second.next_cursor).toBeNull();
      expect(() => listAgentsPage(db, { status: "napping" })).toThrowError(
        expect.objectContaining({ code: "invalid_status" }),
      );
      expect(() => listAgentsPage(db, { cursor: "bogus" })).toThrowError(
        expect.objectContaining({ code: "invalid_cursor" }),
      );
      expect(() => listAgentsPage(db, { limit: 501 })).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
    } finally {
      closeAll();
    }
  });

  it("renames and re-roles agents; duplicate names map to name_taken", () => {
    const db = openTestDb();
    try {
      const a = createAgent(db, { name: "alpha", role: "coder" });
      createAgent(db, { name: "beta", role: "coder" });
      const renamed = updateAgentProfile(db, a.agent_id, {
        name: "alpha-2",
        role: "reviewer",
      });
      expect(renamed.name).toBe("alpha-2");
      expect(renamed.role).toBe("reviewer");
      expect(() =>
        updateAgentProfile(db, a.agent_id, { name: "beta" }),
      ).toThrowError(expect.objectContaining({ code: "name_taken" }));
      expect(() =>
        updateAgentProfile(db, a.agent_id, { role: "  " }),
      ).toThrowError(expect.objectContaining({ code: "invalid_role" }));
      expect(() => updateAgentProfile(db, a.agent_id, {})).toThrowError(
        expect.objectContaining({ code: "invalid_request" }),
      );
      expect(() =>
        updateAgentProfile(db, "00000000-0000-4000-8000-000000000000", {
          name: "ghost",
        }),
      ).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    } finally {
      closeAll();
    }
  });

  it("re-enables a disabled subtree (idempotent, audited)", () => {
    const db = openTestDb();
    try {
      const parent = createAgent(db, { name: "p", role: "orchestrator" });
      const child = createAgent(db, {
        name: "c",
        role: "coder",
        parentAgentId: parent.agent_id,
      });
      const disabled = disableAgentSubtree(db, parent.agent_id, "sess");
      expect(disabled.disabled_count).toBe(2);
      const out = reenableAgentSubtree(db, parent.agent_id, "sess");
      expect(out).toEqual({
        success: true,
        reenabled_count: 2,
        complete: true,
      });
      expect(
        db
          .prepare("SELECT status FROM agents WHERE agent_id = ?")
          .get(child.agent_id),
      ).toEqual({ status: "idle" });
      // Idempotent retry flips nothing.
      expect(reenableAgentSubtree(db, parent.agent_id, "sess")).toEqual({
        success: true,
        reenabled_count: 0,
        complete: true,
      });
      const audits = db
        .prepare(
          "SELECT action FROM audit_log WHERE action = 'agent.reenable.batch'",
        )
        .all();
      expect(audits).toHaveLength(1);
      expect(() =>
        reenableAgentSubtree(
          db,
          "00000000-0000-4000-8000-000000000000",
          "sess",
        ),
      ).toThrowError(expect.objectContaining({ code: "agent_not_found" }));
    } finally {
      closeAll();
    }
  });

  it("serves roster filters, profile PATCH, and re-enable over real HTTP+MCP", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-agent-mgmt-"),
    });
    try {
      const master = bootstrapMaster(app.db!)!;
      const loginRes = await fetch(`${app.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ master_credential: master }),
      });
      expect(loginRes.status).toBe(200);
      const loginBody = (await loginRes.json()) as Record<string, unknown>;
      const rawSet = loginRes.headers.get("set-cookie") ?? "";
      const cookie = cookieOf(rawSet);
      const csrf = loginBody["csrf_token"] as string;
      const headers = {
        cookie: `__Host-polymer_admin=${cookie}`,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      };

      const [a] = await registerAgentsOn(app, ["http-a", "http-b"]);
      await withAuthedClients(app, [a.token], async ([client]) => {
        const roster = (await client.callTool({
          name: "get_agent_roster",
          arguments: { role: "coder", limit: 10 },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        const agents = roster.structuredContent["agents"] as unknown[];
        expect(agents.length).toBeGreaterThanOrEqual(1);
        expect(roster.structuredContent["next_cursor"]).toBeNull();
        const info = (await client.callTool({
          name: "get_agent_info",
          arguments: { agent_id: a.agentId },
        })) as unknown as {
          structuredContent: Record<string, unknown>;
        };
        expect(info.structuredContent["parent_agent_id"]).toBeNull();
        expect(info.structuredContent["heartbeat_timeout_seconds"]).toBe(300);
      });

      // REST roster with filters + pagination.
      const filtered = (await (
        await fetch(`${app.url}/api/agents?role=coder&limit=1`, { headers })
      ).json()) as Record<string, unknown>;
      expect(filtered.agents).toHaveLength(1);
      expect(typeof filtered.next_cursor).toBe("string");
      const bad = await fetch(`${app.url}/api/agents?status=napping`, {
        headers,
      });
      expect(bad.status).toBe(400);

      // PATCH profile (CSRF enforced).
      const noCsrf = await fetch(`${app.url}/api/agents/${a.agentId}`, {
        method: "PATCH",
        headers: { cookie: `__Host-polymer_admin=${cookie}` },
        body: JSON.stringify({ role: "reviewer" }),
      });
      expect(noCsrf.status).toBe(403);
      const patched = await fetch(`${app.url}/api/agents/${a.agentId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ role: "reviewer" }),
      });
      expect(patched.status).toBe(200);
      expect(((await patched.json()) as Record<string, unknown>)["role"]).toBe(
        "reviewer",
      );

      // Disable then re-enable round trip.
      const dis = await fetch(`${app.url}/api/agents/${a.agentId}/disable`, {
        method: "POST",
        headers,
      });
      expect(dis.status).toBe(200);
      const re = await fetch(`${app.url}/api/agents/${a.agentId}/reenable`, {
        method: "POST",
        headers,
      });
      expect(re.status).toBe(200);
      expect(
        ((await re.json()) as Record<string, unknown>)["reenabled_count"],
      ).toBe(1);
      const detail = (await (
        await fetch(`${app.url}/api/agents/${a.agentId}`, { headers })
      ).json()) as Record<string, unknown>;
      expect(detail.status).toBe("idle");
    } finally {
      await app.close();
    }
  });
});
