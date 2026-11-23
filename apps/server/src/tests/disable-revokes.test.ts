import { describe, expect, it } from "vitest";
import { listen } from "../http/server.js";
import { createAgent } from "../identity/agents.js";
import { mintCredential, refreshReconnect } from "../identity/credentials.js";
import {
  disableAgentSubtree,
  reenableAgentSubtree,
} from "../identity/disable.js";
import { registerSubagent } from "../identity/registration.js";
import { tempDbPath } from "./test-support.js";

describe("disable revokes credentials (#145)", () => {
  it("a disabled agent cannot read over MCP, post OTLP, or refresh; re-enable does not resurrect", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-disable-revokes-"),
    });
    try {
      const db = app.db!;
      const parent = createAgent(db, { name: "p", role: "coder" });
      const child = createAgent(db, {
        name: "c",
        role: "coder",
        parentAgentId: parent.agent_id,
      });
      const mint = (agentId: string) => ({
        session: mintCredential(db, { type: "agent_session", agentId }).secret,
        reconnect: mintCredential(db, { type: "agent_reconnect", agentId })
          .secret,
      });
      const p = mint(parent.agent_id);
      const c = mint(child.agent_id);

      const mcpRead = (token: string) =>
        fetch(`${app.url}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
      const otlp = (token: string) =>
        fetch(`${app.url}/otel/v1/traces`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ resourceSpans: [] }),
        });
      // Sanity: both credentials authenticate before disable.
      expect((await mcpRead(c.session)).status).not.toBe(401);
      expect((await otlp(c.session)).status).not.toBe(401);

      disableAgentSubtree(db, parent.agent_id, "admin-session");

      // Cascade: the child's credentials die with the parent's.
      for (const t of [p, c]) {
        expect((await mcpRead(t.session)).status).toBe(401);
        expect((await otlp(t.session)).status).toBe(401);
        expect(() => refreshReconnect(db, t.reconnect)).toThrow();
      }

      reenableAgentSubtree(db, parent.agent_id, "admin-session");
      expect((await mcpRead(p.session)).status).toBe(401);
      expect(() => refreshReconnect(db, p.reconnect)).toThrow();
    } finally {
      await app.close();
    }
  });

  it("a spawn racing the disable still gets parent_disabled in the insert transaction", async () => {
    const app = await listen("127.0.0.1", 0, {
      databasePath: tempDbPath("polymer-disable-revokes-"),
    });
    try {
      const parent = createAgent(app.db!, { name: "p", role: "coder" });
      app
        .db!.prepare("UPDATE agents SET status = 'disabled' WHERE agent_id = ?")
        .run(parent.agent_id);
      expect(() =>
        registerSubagent(app.db!, parent.agent_id, {
          name: "x",
          role: "coder",
        }),
      ).toThrow(/parent_disabled/);
    } finally {
      await app.close();
    }
  });
});
