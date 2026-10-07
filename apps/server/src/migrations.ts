/**
 * Component 4: versioned SQLite migrations (hand-rolled, no framework).
 *
 * Component 5 adds the agents table (migration 002). Component 6 adds
 * the credentials table (migration 003). Application tables
 * for later components (tasks, ...) must each add their own
 * numbered migration here.
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
  {
    version: 2,
    name: "002_agents",
    up: `CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  parent_agent_id TEXT NULL REFERENCES agents(agent_id),
  status TEXT NOT NULL DEFAULT 'connecting'
    CHECK(status IN ('connecting', 'connected', 'idle', 'working', 'error', 'disconnected', 'disabled')),
  heartbeat_timeout_seconds INTEGER NOT NULL DEFAULT 300 CHECK(heartbeat_timeout_seconds > 0),
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  connected_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);`,
    down: `DROP TABLE IF EXISTS agents;`,
  },
  {
    version: 3,
    name: "003_credentials",
    up: `CREATE TABLE credentials (
  credential_id TEXT PRIMARY KEY,
  public_id TEXT NULL,
  type TEXT NOT NULL
    CHECK(type IN ('master', 'init', 'agent_session', 'agent_reconnect', 'admin_session')),
  token_hash TEXT NOT NULL,
  agent_id TEXT NULL REFERENCES agents(agent_id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'used', 'revoked', 'expired')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NULL,
  last_used_at TEXT NULL,
  rotated_from_credential_id TEXT NULL REFERENCES credentials(credential_id)
);
CREATE INDEX IF NOT EXISTS idx_credentials_agent ON credentials(agent_id);
CREATE INDEX IF NOT EXISTS idx_credentials_public ON credentials(public_id);`,
    down: `DROP TABLE IF EXISTS credentials;`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
