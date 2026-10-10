/**
 * Component 4: versioned SQLite migrations (hand-rolled, no framework).
 *
 * Component 5 adds the agents table (migration 002). Component 6 adds
 * the credentials table (migration 003). Component 10 adds the tasks
 * and task_assignments tables (migration 004). Application tables
 * for later components must each add their own numbered migration here.
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
  {
    version: 4,
    name: "004_tasks",
    up: `CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(title) > 0),
  description TEXT NULL,
  status TEXT NOT NULL DEFAULT 'to_do'
    CHECK(status IN ('to_do', 'in_progress', 'done', 'failed')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  created_by TEXT NOT NULL REFERENCES agents(agent_id),
  coordinator TEXT NOT NULL REFERENCES agents(agent_id),
  lease_expires_at TEXT NULL,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation >= 0),
  trace_parent TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_coordinator ON tasks(coordinator);
CREATE TABLE task_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(task_id, agent_id)
);`,
    down: `DROP TABLE IF EXISTS task_assignments;
DROP TABLE IF EXISTS tasks;`,
  },
  {
    version: 5,
    name: "005_comments",
    up: `CREATE TABLE comments (
  comment_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  sender_agent_id TEXT NULL REFERENCES agents(agent_id),
  sender_type TEXT NOT NULL DEFAULT 'agent'
    CHECK(sender_type IN ('agent', 'human')),
  content TEXT NOT NULL,
  trace_parent TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
CREATE TABLE mentions (
  mention_id TEXT PRIMARY KEY,
  comment_id TEXT NOT NULL REFERENCES comments(comment_id),
  mentioned_agent_id TEXT NOT NULL REFERENCES agents(agent_id),
  read INTEGER NOT NULL DEFAULT 0 CHECK(read IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_mentions_agent ON mentions(mentioned_agent_id, read);`,
    down: `DROP TABLE IF EXISTS mentions;
DROP TABLE IF EXISTS comments;`,
  },
  {
    version: 6,
    name: "006_audit",
    up: `CREATE TABLE audit_log (
  audit_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL
    CHECK(actor_type IN ('admin_session', 'master', 'system')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  task_id TEXT NULL REFERENCES tasks(task_id),
  before TEXT NULL,
  after TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_task_time ON audit_log(task_id, created_at);
ALTER TABLE credentials ADD COLUMN csrf TEXT NULL;`,
    down: `DROP TABLE IF EXISTS audit_log;
ALTER TABLE credentials DROP COLUMN csrf;`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
