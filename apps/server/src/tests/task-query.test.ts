import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../database/db.js";
import { createAgent } from "../identity/agents.js";
import {
  adminBulkAssign,
  adminBulkUpdateStatus,
  adminClaimTask,
  createTask,
  listTasks,
  listTasksPage,
} from "../tasks/index.js";

function setup() {
  const db = openDatabase(
    join(mkdtempSync(join(tmpdir(), "polymer-q-")), "t.db"),
  );
  const a = createAgent(db, { name: "qa", role: "coder" });
  const b = createAgent(db, { name: "qb", role: "coder" });
  const t1 = createTask(db, {
    title: "Alpha query task",
    createdBy: a.agent_id,
  });
  const t2 = createTask(db, { title: "Beta thing", createdBy: a.agent_id });
  const t3 = createTask(db, { title: "alpha second", createdBy: b.agent_id });
  return { db, a, b, t1, t2, t3 };
}

describe("task query: q, coordinator, ordering, cursor parity, bulk", () => {
  it("q matches title case-insensitively with literal wildcards", () => {
    const { db } = setup();
    expect(
      listTasks(db, { q: "ALPHA" })
        .map((t) => t.title)
        .sort(),
    ).toEqual(["Alpha query task", "alpha second"]);
    expect(listTasks(db, { q: "Alpha%" })).toEqual([]);
  });

  it("coordinator filter + updated_at ordering work", () => {
    const { db, a, b } = setup();
    expect(
      listTasks(db, { coordinator: b.agent_id }).map((t) => t.title),
    ).toEqual(["alpha second"]);
    const asc = listTasks(db, { orderBy: "updated_at", orderDir: "asc" });
    const desc = listTasks(db, { orderBy: "updated_at", orderDir: "desc" });
    expect(desc.map((t) => t.task_id)).toEqual(
      [...asc].reverse().map((t) => t.task_id),
    );
    expect(
      listTasks(db, { coordinator: a.agent_id, q: "beta" }).map((t) => t.title),
    ).toEqual(["Beta thing"]);
  });

  it("MCP limit/cursor path (listTasks) matches REST page grammar", () => {
    const { db } = setup();
    const p1 = listTasksPage(db, { limit: 2 });
    expect(p1.tasks).toHaveLength(2);
    expect(p1.next_cursor).not.toBeNull();
    const viaCursor = listTasks(db, { limit: 5, cursor: p1.next_cursor! });
    const p2 = listTasksPage(db, { limit: 5, cursor: p1.next_cursor! });
    expect(viaCursor.map((t) => t.task_id)).toEqual(
      p2.tasks.map((t) => t.task_id),
    );
    expect(p2.next_cursor).toBeNull();
  });

  it("admin bulk status closes out in_progress tasks with audit-safe errors", () => {
    const { db, t1, t2 } = setup();
    // move t1/t2 to in_progress via admin claim bypass
    adminClaimTask(db, t1.task_id, "sess");
    adminClaimTask(db, t2.task_id, "sess");
    const out = adminBulkUpdateStatus(
      db,
      [t1.task_id, t2.task_id, "missing"],
      "sess",
      "done",
    );
    expect(out.results.filter((r) => r.ok)).toHaveLength(2);
    expect(out.results.find((r) => r.task_id === "missing")).toMatchObject({
      ok: false,
      error: "task_not_found",
    });
    // done is terminal even for bulk
    const again = adminBulkUpdateStatus(db, [t1.task_id], "sess", "failed");
    expect(again.results[0].ok).toBe(false);
  });

  it("admin bulk assign reports per-item results", () => {
    const { db, a, t1, t2 } = setup();
    const out = adminBulkAssign(db, [t1.task_id, t2.task_id], "sess", [
      a.agent_id,
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    const dup = adminBulkAssign(db, [t1.task_id], "sess", [a.agent_id]);
    expect(dup.results[0]).toMatchObject({
      ok: false,
      error: "already_assigned",
    });
  });
});
