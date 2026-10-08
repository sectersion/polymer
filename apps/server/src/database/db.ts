import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { LATEST_VERSION, MIGRATIONS } from "./migrations.js";

export type PolymerDatabase = Database.Database;

export const DEFAULT_DATABASE_PATH = "./polymer.db";

export function resolveDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env["POLYMER_DATABASE_PATH"];
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  return DEFAULT_DATABASE_PATH;
}

function ensureVersionTable(db: PolymerDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`,
  );
}

export function getAppliedVersions(db: PolymerDatabase): number[] {
  ensureVersionTable(db);
  const rows = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
    .all() as Array<{ version: number }>;
  return rows.map((r) => r.version);
}

export function getSchemaVersion(db: PolymerDatabase): number {
  const versions = getAppliedVersions(db);
  return versions.length === 0 ? 0 : versions[versions.length - 1]!;
}

/** Apply all pending migrations in order, one transaction each. */
export function migrateUp(db: PolymerDatabase): number[] {
  ensureVersionTable(db);
  const applied = new Set(getAppliedVersions(db));
  const newly: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const txn = db.transaction(() => {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
        m.version,
      );
    });
    txn();
    newly.push(m.version);
  }
  return newly;
}

/** Roll back the most recently applied migration (single transaction). */
export function migrateDown(db: PolymerDatabase): number | null {
  ensureVersionTable(db);
  const row = db
    .prepare(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .get() as { version: number } | undefined;
  if (!row) return null;
  const m = MIGRATIONS.find((cand) => cand.version === row.version);
  if (!m) throw new Error(`unknown applied migration version: ${row.version}`);
  const txn = db.transaction(() => {
    db.exec(m.down);
    db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(
      m.version,
    );
  });
  txn();
  return m.version;
}

/**
 * Open (creating parent dirs as needed) and configure a SQLite database:
 * foreign keys ON, WAL mode, 5000ms busy timeout — then run migrations.
 * Fails closed on error; never falls back to :memory:.
 */
export function openDatabase(path: string): PolymerDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db: PolymerDatabase = new Database(path);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    migrateUp(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export function closeDatabase(db: PolymerDatabase): void {
  db.close();
}

/**
 * Wipe the database files at `path` (main + WAL/SHM sidecars) and reopen
 * fresh at the latest schema version. Dev/test recovery only.
 */
export function migrateReset(path: string): PolymerDatabase {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      rmSync(`${path}${suffix}`, { force: true });
    } catch {
      // Best effort; openDatabase below surfaces real failures.
    }
  }
  return openDatabase(path);
}

export { LATEST_VERSION };
