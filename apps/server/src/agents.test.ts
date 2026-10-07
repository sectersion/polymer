import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getSchemaVersion,
  openDatabase,
  type PolymerDatabase,
} from "./db.js";
import {
  AgentNameTakenError,
  AgentNotFoundError,
  createAgent,
  getAgentById,
  heartbeatAgent,
  listAgents,
  updateAgentStatus,
} from "./agents.js";

const openHandles: PolymerDatabase[] = [];

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-agents-")), "test.db");
}

afterEach(() => {
  while (openHandles.length > 0) closeDatabase(openHandles.pop()!);
});

function openTestDb(): { db: PolymerDatabase; path: string } {
  const path = tempDbPath();
  const db = openDatabase(path);
  openHandles.push(db);
  return { db, path };
}

describe("Agent table + service (component 5)", () => {
  it("creates and fetches an agent with matching values", () => {
    const { db } = openTestDb();
    const created = createAgent(db, { name: "alpha", role: "coder" });
    expect(created.agent_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(created.parent_agent_id).toBeNull();
    expect(created.status).toBe("connecting");
    expect(created.heartbeat_timeout_seconds).toBe(300);
    const fetched = getAgentById(db, created.agent_id);
    expect(fetched).toEqual(created);
  });

  it("persists agents across a server restart (close + reopen)", () => {
    const { db, path } = openTestDb();
    const created = createAgent(db, { name: "alpha", role: "coder" });
    closeDatabase(openHandles.pop()!);
    const reopened = openDatabase(path);
    openHandles.push(reopened);
    expect(getSchemaVersion(reopened)).toBe(2);
    expect(getAgentById(reopened, created.agent_id)).toEqual(created);
  });

  it("heartbeat advances last_seen", () => {
    const { db } = openTestDb();
    const created = createAgent(db, { name: "alpha", role: "coder" });
    db.prepare("UPDATE agents SET last_seen = ? WHERE agent_id = ?").run(
      "2000-01-01T00:00:00.000Z",
      created.agent_id,
    );
    const beat = heartbeatAgent(
      db,
      created.agent_id,
      "2026-10-07T00:00:00.000Z",
    );
    expect(beat.last_seen).toBe("2026-10-07T00:00:00.000Z");
    expect(getAgentById(db, created.agent_id)?.last_seen).toBe(
      "2026-10-07T00:00:00.000Z",
    );
  });

  it("rejects duplicate names with name_taken", () => {
    const { db } = openTestDb();
    createAgent(db, { name: "alpha", role: "coder" });
    const err = (() => {
      try {
        createAgent(db, { name: "alpha", role: "reviewer" });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgentNameTakenError);
    expect((err as AgentNameTakenError).code).toBe("name_taken");
  });

  it("rejects unknown parent references", () => {
    const { db } = openTestDb();
    expect(() =>
      createAgent(db, {
        name: "child",
        role: "coder",
        parentAgentId: "00000000-0000-4000-8000-000000000000",
      }),
    ).toThrow(AgentNotFoundError);
  });

  it("links a child to its parent set only at creation", () => {
    const { db } = openTestDb();
    const parent = createAgent(db, { name: "parent", role: "orchestrator" });
    const child = createAgent(db, {
      name: "child",
      role: "coder",
      parentAgentId: parent.agent_id,
    });
    expect(child.parent_agent_id).toBe(parent.agent_id);
    // No updater touches parent_agent_id: status + heartbeat preserve it.
    updateAgentStatus(db, child.agent_id, "working");
    heartbeatAgent(db, child.agent_id);
    expect(getAgentById(db, child.agent_id)?.parent_agent_id).toBe(
      parent.agent_id,
    );
  });

  it("updates status and rejects invalid statuses", () => {
    const { db } = openTestDb();
    const created = createAgent(db, { name: "alpha", role: "coder" });
    expect(updateAgentStatus(db, created.agent_id, "working").status).toBe(
      "working",
    );
    expect(() => updateAgentStatus(db, created.agent_id, "napping")).toThrow();
    expect(() =>
      createAgent(db, {
        name: "beta",
        role: "coder",
        status: "napping" as never,
      }),
    ).toThrow();
  });

  it("lists agents and throws agent_not_found for unknown ids", () => {
    const { db } = openTestDb();
    createAgent(db, { name: "alpha", role: "coder" });
    createAgent(db, { name: "beta", role: "reviewer" });
    expect(listAgents(db).map((a) => a.name)).toEqual(["alpha", "beta"]);
    expect(
      getAgentById(db, "00000000-0000-4000-8000-000000000000"),
    ).toBeUndefined();
    expect(() =>
      updateAgentStatus(db, "00000000-0000-4000-8000-000000000000", "idle"),
    ).toThrow(AgentNotFoundError);
    expect(() =>
      heartbeatAgent(db, "00000000-0000-4000-8000-000000000000"),
    ).toThrow(AgentNotFoundError);
  });
});
