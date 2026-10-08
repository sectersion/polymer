import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createAgent } from "../identity/agents.js";
import { closeDatabase, openDatabase } from "../database/db.js";
import {
  createTask,
  getTask,
  listTaskAssignees,
  listTasks,
} from "../tasks/index.js";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-tasks-")), "test.db");
}

function seedAgent(db: ReturnType<typeof openDatabase>, name: string): string {
  return createAgent(db, { name, role: "coder" }).agent_id;
}

describe("Task storage (component 10)", () => {
  it("creates a task with every field persisted", () => {
    const db = openDatabase(tempDbPath());
    try {
      const agentId = seedAgent(db, "alpha");
      const before = Date.now();
      const task = createTask(db, {
        title: "  Ship it  ",
        description: "details",
        traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        createdBy: agentId,
      });
      const after = Date.now();
      expect(task.task_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(task.title).toBe("Ship it");
      expect(task.description).toBe("details");
      expect(task.status).toBe("to_do");
      expect(task.version).toBe(1);
      expect(task.created_by).toBe(agentId);
      expect(task.coordinator).toBe(agentId);
      expect(task.lease_generation).toBe(1);
      const expiry = Date.parse(task.lease_expires_at!);
      expect(expiry).toBeGreaterThanOrEqual(before + 3600_000);
      expect(expiry).toBeLessThanOrEqual(after + 3600_000);
      expect(task.trace_parent).toBe(
        "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      );
      expect(Date.parse(task.created_at)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(task.updated_at)).toBeGreaterThanOrEqual(before);
      // The creator coordinates but is not an assignee.
      expect(listTaskAssignees(db, task.task_id)).toEqual([]);

      // Read-back through getTask matches exactly.
      expect(getTask(db, task.task_id)).toEqual(task);
    } finally {
      closeDatabase(db);
    }
  });

  it("tasks survive close and reopen (durable without MCP/REST)", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    const agentId = seedAgent(first, "alpha");
    const created = createTask(first, {
      title: "persist me",
      createdBy: agentId,
    });
    closeDatabase(first);

    const second = openDatabase(path);
    try {
      expect(getTask(second, created.task_id)).toEqual(created);
      expect(listTasks(second).map((t) => t.task_id)).toContain(
        created.task_id,
      );
    } finally {
      closeDatabase(second);
    }
  });

  it("rejects unknown created_by/coordinator with agent_not_found", () => {
    const db = openDatabase(tempDbPath());
    try {
      const agentId = seedAgent(db, "alpha");
      const missing = "00000000-0000-4000-8000-000000000000";
      expect(() =>
        createTask(db, { title: "x", createdBy: missing }),
      ).toThrowError("agent not found");
      try {
        createTask(db, {
          title: "x",
          createdBy: agentId,
          coordinator: missing,
        });
        expect.unreachable();
      } catch (err) {
        expect((err as { code?: string }).code).toBe("agent_not_found");
      }
      expect(() =>
        createTask(db, { title: "  ", createdBy: agentId }),
      ).toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  it("enforces foreign keys and assignment uniqueness", () => {
    const db = openDatabase(tempDbPath());
    try {
      const agentId = seedAgent(db, "alpha");
      const task = createTask(db, { title: "x", createdBy: agentId });
      // Valid assignment row, then a duplicate violates UNIQUE(task_id, agent_id).
      db.prepare(
        "INSERT INTO task_assignments (task_id, agent_id) VALUES (?, ?)",
      ).run(task.task_id, agentId);
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_assignments (task_id, agent_id) VALUES (?, ?)",
          )
          .run(task.task_id, agentId),
      ).toThrow();
      expect(
        listTaskAssignees(db, task.task_id).map((a) => a.agent_id),
      ).toEqual([agentId]);
      // Dangling references violate foreign keys.
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_assignments (task_id, agent_id) VALUES (?, ?)",
          )
          .run("00000000-0000-4000-8000-000000000000", agentId),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO task_assignments (task_id, agent_id) VALUES (?, ?)",
          )
          .run(task.task_id, "00000000-0000-4000-8000-000000000000"),
      ).toThrow();
      expect(() =>
        db
          .prepare(
            "INSERT INTO tasks (task_id, title, created_by, coordinator) VALUES (?, ?, ?, ?)",
          )
          .run(
            "11111111-1111-4111-8111-111111111111",
            "orphan",
            "00000000-0000-4000-8000-000000000000",
            "00000000-0000-4000-8000-000000000000",
          ),
      ).toThrow();
    } finally {
      closeDatabase(db);
    }
  });

  it("listTasks filters and caps; getTask misses cleanly", () => {
    const db = openDatabase(tempDbPath());
    try {
      const a = seedAgent(db, "alpha");
      const b = seedAgent(db, "beta");
      createTask(db, { title: "one", createdBy: a });
      createTask(db, { title: "two", createdBy: a });
      createTask(db, { title: "three", createdBy: b });
      expect(listTasks(db)).toHaveLength(3);
      expect(listTasks(db, { createdBy: a })).toHaveLength(2);
      expect(listTasks(db, { status: "to_do" })).toHaveLength(3);
      expect(listTasks(db, { status: "done" })).toHaveLength(0);
      expect(listTasks(db, { limit: 2 })).toHaveLength(2);
      expect(() => listTasks(db, { status: "nope" })).toThrowError(
        "invalid task status",
      );
      expect(() => listTasks(db, { limit: 501 })).toThrow();
      expect(
        getTask(db, "00000000-0000-4000-8000-000000000000"),
      ).toBeUndefined();
    } finally {
      closeDatabase(db);
    }
  });
});
