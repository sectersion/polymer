import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST_VERSION,
  closeDatabase,
  getAppliedVersions,
  getSchemaVersion,
  migrateDown,
  migrateReset,
  migrateUp,
  openDatabase,
  resolveDatabasePath,
  type PolymerDatabase,
} from "../database/db.js";
import { listen } from "../http/server.js";

const openHandles: PolymerDatabase[] = [];

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "polymer-db-")), "test.db");
}

afterEach(() => {
  while (openHandles.length > 0) closeDatabase(openHandles.pop()!);
});

function tableExists(db: PolymerDatabase, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

describe("SQLite connection and migrations (component 4)", () => {
  it("brings an empty database to the expected schema version", () => {
    const db = openDatabase(tempDbPath());
    openHandles.push(db);
    expect(getSchemaVersion(db)).toBe(LATEST_VERSION);
    expect(tableExists(db, "_migration_probe")).toBe(true);
    expect(tableExists(db, "agents")).toBe(true);
    expect(tableExists(db, "credentials")).toBe(true);
    expect(tableExists(db, "schema_migrations")).toBe(true);
  });

  it("enforces WAL mode, foreign keys, and busy timeout", () => {
    const db = openDatabase(tempDbPath());
    openHandles.push(db);
    const journal = db.prepare("PRAGMA journal_mode;").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode.toLowerCase()).toBe("wal");
    const fk = db.prepare("PRAGMA foreign_keys;").get() as {
      foreign_keys: number;
    };
    expect(fk.foreign_keys).toBe(1);
    const busy = db.prepare("PRAGMA busy_timeout;").get() as {
      timeout: number;
    };
    expect(busy.timeout).toBe(5000);
    // Foreign keys are actually enforced, not just flagged on.
    db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY);");
    db.exec(
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));",
    );
    expect(() =>
      db.prepare("INSERT INTO child (parent_id) VALUES (999)").run(),
    ).toThrow();
  });

  it("second startup does not duplicate migrations", () => {
    const path = tempDbPath();
    const first = openDatabase(path);
    openHandles.push(first);
    expect(getAppliedVersions(first)).toEqual([1, 2, 3, 4, 5]);
    closeDatabase(openHandles.pop()!);
    const second = openDatabase(path);
    openHandles.push(second);
    expect(getAppliedVersions(second)).toEqual([1, 2, 3, 4, 5]);
    expect(getSchemaVersion(second)).toBe(5);
    const applied = migrateUp(second);
    expect(applied).toEqual([]);
  });

  it("rollback removes the latest migration; up re-applies", () => {
    const db = openDatabase(tempDbPath());
    openHandles.push(db);
    expect(migrateDown(db)).toBe(5);
    expect(getSchemaVersion(db)).toBe(4);
    expect(tableExists(db, "comments")).toBe(false);
    expect(tableExists(db, "mentions")).toBe(false);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "task_assignments")).toBe(true);
    expect(tableExists(db, "credentials")).toBe(true);
    expect(migrateDown(db)).toBe(4);
    expect(getSchemaVersion(db)).toBe(3);
    expect(tableExists(db, "tasks")).toBe(false);
    expect(tableExists(db, "task_assignments")).toBe(false);
    expect(tableExists(db, "credentials")).toBe(true);
    expect(migrateDown(db)).toBe(3);
    expect(getSchemaVersion(db)).toBe(2);
    expect(tableExists(db, "credentials")).toBe(false);
    expect(tableExists(db, "agents")).toBe(true);
    expect(migrateDown(db)).toBe(2);
    expect(getSchemaVersion(db)).toBe(1);
    expect(tableExists(db, "agents")).toBe(false);
    expect(tableExists(db, "_migration_probe")).toBe(true);
    expect(migrateDown(db)).toBe(1);
    expect(getSchemaVersion(db)).toBe(0);
    expect(tableExists(db, "_migration_probe")).toBe(false);
    expect(migrateDown(db)).toBeNull();
    expect(migrateUp(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tableExists(db, "_migration_probe")).toBe(true);
    expect(tableExists(db, "agents")).toBe(true);
    expect(tableExists(db, "credentials")).toBe(true);
    expect(tableExists(db, "tasks")).toBe(true);
    expect(tableExists(db, "comments")).toBe(true);
    expect(tableExists(db, "mentions")).toBe(true);
  });

  it("reset wipes and reinitializes to the latest version", () => {
    const path = tempDbPath();
    const db = openDatabase(path);
    openHandles.push(db);
    db.prepare("INSERT INTO _migration_probe DEFAULT VALUES").run();
    closeDatabase(openHandles.pop()!);
    const fresh = migrateReset(path);
    openHandles.push(fresh);
    expect(getSchemaVersion(fresh)).toBe(LATEST_VERSION);
    const count = (
      fresh.prepare("SELECT COUNT(*) AS n FROM _migration_probe").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(0);
  });

  it("server startup opens and migrates the configured database", async () => {
    const path = tempDbPath();
    const app = await listen("127.0.0.1", 0, { databasePath: path });
    try {
      const res = await fetch(`${app.url}/health`);
      expect(res.status).toBe(200);
      expect(app.db).not.toBeNull();
      expect(getSchemaVersion(app.db!)).toBe(LATEST_VERSION);
      expect(tableExists(app.db!, "_migration_probe")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("resolves the database path from the environment", () => {
    expect(resolveDatabasePath({})).toBe("./polymer.db");
    expect(resolveDatabasePath({ POLYMER_DATABASE_PATH: "/tmp/x.db" })).toBe(
      "/tmp/x.db",
    );
    expect(resolveDatabasePath({ POLYMER_DATABASE_PATH: "  " })).toBe(
      "./polymer.db",
    );
  });
});
