/**
 * Component 4: versioned SQLite migrations (hand-rolled, no framework).
 *
 * Exactly one migration exists in this component: a trivial probe table.
 * Application tables (agents, credentials, tasks, ...) land in later
 * components and must each add their own numbered migration here.
 */

export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "001_init_probe",
    up: `CREATE TABLE IF NOT EXISTS _migration_probe (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);`,
    down: `DROP TABLE IF EXISTS _migration_probe;`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
