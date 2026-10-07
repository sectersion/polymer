# Polymer: Agent Fleet Management & Observability

## Problem Statement

Teams running autonomous multi-agent workflows lack clear coordination
and useful fleet-level observability. Polymer aims to make it easier to
understand who is working, what they are doing, what a workflow costs,
and where handoffs or failures occur. Telemetry volume and cost can grow
rapidly as agent workflows become more complex.

**Current gaps:** - No unified fleet visibility (who's working, what
they're doing, what it costs) - Agents can't coordinate cleanly (task
dependencies, messaging, race conditions, deadlocks) - Human-readable
inter-agent communication is missing - Fleet-level signals collapse
individual trace trees across inter-agent handoffs

## Solution Overview

**Polymer** is a three-layer system:

1.  **Agents** (anywhere) --- Fetch Polymer skill, connect to server via
    MCP
2.  **Polymer Server** (TypeScript/Node) --- Central hub, routes
    messages, tracks fleet state, manages task leases
3.  **Polymer Web UI** (Next.js) --- View tasks, agents, messages;
    manage tokens; monitor telemetry

Agents create tasks (kanban-style), coordinate via comments with
@mentions, pass trace context across tasks, and emit OTel telemetry.
Humans observe and control via web UI.

## Architecture

    Agent (Claude Code, OpenSWE, etc)
      ↓ (MCP + OTel)
    Polymer Server (Node.js + Express/Hono)
      ├─ MCP Server (agent tools)
      ├─ REST API (web UI)
      ├─ OTel Receiver (telemetry)
      ├─ SQLite (MVP; coordination state and telemetry tables)
      └─ Bounded telemetry queue + batched writer

    PostgreSQL is a later supported backend, after the SQLite implementation and storage interface are stable.
      
    Web UI (Next.js)
      ↑ (REST API + WebSocket)

## Data Model

### Core Entities

**Agent**

    - agent_id (UUID)
    - name (string)
    - role (string) // "coder", "reviewer", "orchestrator", etc
    - parent_agent_id (optional UUID) // for subagents
    - status (enum) // "connecting", "connected", "idle", "working", "error", "disconnected"
    - heartbeat_timeout_seconds (int, default=300)
    - last_seen (timestamp)
    - connected_at (timestamp)
    - created_at (timestamp)

**Credential**

    - credential_id (UUID)
    - public_id (string, non-secret lookup prefix/identifier)
    - type ("master" | "enrollment" | "agent_session" | "agent_reconnect" | "admin_session")
    - token_hash (string, hash of high-entropy opaque secret; never plaintext)
    - agent_id (optional UUID, for agent credentials)
    - status ("active" | "used" | "revoked" | "expired")
    - created_at (timestamp)
    - expires_at (timestamp, nullable)
    - last_used_at (timestamp, nullable)
    - rotated_from_credential_id (optional UUID)

Generate opaque secrets with a cryptographically secure random source
and at least 256 bits of entropy. Hash them with SHA-256 for
lookup/storage; these are random machine credentials, not human
passwords. Never log secrets. Keep the master credential separate from
agent credentials and administrator browser sessions.

**Task** (kanban card)

    - task_id (UUID)
    - title (string)
    - description (optional string)
    - status (enum) // "to_do", "in_progress", "done", "failed"
    - version (int, default=1) // Optimistic concurrency control
    - created_by (agent_id)
    - coordinator (agent_id) // can assign/transfer/complete
    - lease_expires_at (timestamp, nullable)
    - lease_generation (integer, default=0) // Fencing token; incremented on every new lease
    - trace_parent (optional string) // W3C Trace Context propagation
    - created_at (timestamp)
    - updated_at (timestamp)

**TaskAssignment** (join table, multiple agents per task)

    - id (int)
    - task_id (UUID)
    - agent_id (UUID)
    - assigned_at (timestamp)
    UNIQUE(task_id, agent_id)

**Comment** (task comments)

    - comment_id (UUID)
    - task_id (UUID)
    - sender_agent_id (UUID, nullable if human)
    - sender_type ("agent" | "human")
    - content (string)
    - trace_parent (optional string) // Distributed trace context for handoffs
    - created_at (timestamp)

**Mention** (ping/notification)

    - mention_id (UUID)
    - comment_id (UUID)
    - mentioned_agent_id (UUID)
    - read (boolean, default false)
    - created_at (timestamp)

**OTelSpan** (telemetry)

    - span_id (string, 16 lowercase hex characters; OpenTelemetry-native ID)
    - trace_id (string, 32 lowercase hex characters; OpenTelemetry-native ID)
    - parent_span_id (string, optional, 16 lowercase hex characters)
    - agent_id (UUID, optional; derived from authenticated ingestion identity)
    - task_id (UUID, optional; indexed when frequently queried)
    - name (string)
    - kind (integer/string; OpenTelemetry span kind)
    - start_time_unix_ns (integer)
    - end_time_unix_ns (integer)
    - status_code (OpenTelemetry status code)
    - status_message (string, optional)
    - resource_attributes (JSON)
    - span_attributes (JSON)
    - instrumentation_scope (JSON/string, optional)
    - received_at (timestamp)

Trace and span IDs are OpenTelemetry identifiers, not UUIDs. Preserve
their native representation. Store flexible attributes as JSON, and
promote only commonly filtered/joined fields to columns. Add a child
table for span events if needed; add span links when workflows need
links between otherwise separate traces.

**UsageRecord** (structured model usage/cost attribution)

    - usage_id (UUID)
    - agent_id (UUID; server-validated identity)
    - task_id (UUID, optional)
    - trace_id (string, optional)
    - provider (string, optional)
    - model (string, optional)
    - input_tokens (integer, optional)
    - output_tokens (integer, optional)
    - other_token_categories (JSON, optional)
    - reported_cost_usd (numeric/decimal, optional)
    - cost_source ("reported" | "estimated" | "unknown")
    - recorded_at (timestamp)

Cost may be reported by an integration or estimated from usage and
pricing data; it is not necessarily authoritative billing data. Do not
use binary floating-point as the canonical representation of money.

For the MVP, derive task counts, task durations, and agent activity from
coordination tables and spans. Do not implement a generic metrics store
until a real integration requires it. If OTLP metrics are accepted
later, preserve metric type, temporality, aggregation, and histogram
semantics rather than reducing every metric to a single float.

### Indexes

``` sql
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_coordinator ON tasks(coordinator);
CREATE INDEX idx_comments_task ON comments(task_id);
CREATE INDEX idx_mentions_agent ON mentions(mentioned_agent_id, read);
CREATE INDEX idx_otel_spans_trace ON otel_spans(trace_id);
CREATE INDEX idx_otel_spans_agent_start ON otel_spans(agent_id, start_time_unix_ns);
CREATE INDEX idx_otel_spans_start ON otel_spans(start_time_unix_ns);
CREATE INDEX idx_usage_task_time ON usage_records(task_id, recorded_at);
CREATE INDEX idx_usage_agent_time ON usage_records(agent_id, recorded_at);
```

## MCP Tools (Agents Call These)

### Agent Management

**register_agent** - Input:
`{ init_token, name, role, parent_agent_id?, heartbeat_timeout_seconds? }` -
Output: `{ agent_id, session_token, reconnect_secret, expires_in }` -
Errors: `invalid_token`, `token_expired`, `already_registered`

**send_heartbeat** - Input: `{}` - Output:
`{ success: true, timestamp }` - Errors: `unauthorized`,
`agent_not_found`

**get_agent_roster** - Input: `{}` - Output:
`{ agents: [{ agent_id, name, role, status, last_seen, parent_agent_id }] }`

**get_agent_info** - Input: `{ agent_id }` - Output:
`{ agent_id, name, role, status, last_seen, connected_at, tasks_created, tasks_assigned }`

### Task Operations

**claim_task** (Atomic Lock Acquisition) - Input:
`{ task_id, lease_duration_seconds? }` - Output:
`{ task_id, title, status: "in_progress", coordinator, version, lease_expires_at, lease_generation }` -
Semantics: acquire the lease atomically in a database transaction;
increment `lease_generation` on each successful acquisition.
Coordinator-only mutations must validate the authenticated caller,
current lease generation, and expected task version in the same
transaction. - Errors: `task_already_claimed`, `task_not_found`,
`version_mismatch`

**create_task** - Input: `{ title, description?, trace_parent? }` -
Output:
`{ task_id, title, status, created_by, coordinator, assigned_to, trace_parent, created_at }`

**get_tasks** - Input:
`{ status?, created_by?, assigned_to?, limit? }` - Output:
`{ tasks: [...] }`

**get_task_detail** - Input: `{ task_id }` - Output:
`{ task_id, title, description, status, version, created_by, coordinator, lease_expires_at, trace_parent, assigned_to, comments: [...], created_at, updated_at }`

**update_task_status** - Input:
`{ task_id, status: "in_progress"|"done"|"failed", expected_version: int, lease_generation: int }` -
Output: `{ task_id, status, version, updated_at }` - Errors:
`invalid_status`, `unauthorized`, `task_not_found`, `version_mismatch`

**assign_task** - Input: `{ task_id, agent_ids: [string] }` - Output:
`{ task_id, assigned_to, updated_at }` - Errors: `unauthorized`,
`agent_not_found`, `already_assigned`

**transfer_coordinator** - Input: `{ task_id, new_coordinator_id }` -
Output: `{ task_id, coordinator, updated_at }`

**request_unassignment** - Input: `{ task_id, reason? }` - Output:
`{ success, message }`

### Communication

**post_comment** - Input: `{ task_id, content, trace_parent? }` -
Output:
`{ comment_id, task_id, sender_agent_id, content, mentions: [agent_ids], trace_parent, created_at }` -
Parsing: `@agent_name` in content creates mentions

**get_unread_pings** - Input: `{}` - Output:
`{ pings: [{ mention_id, comment_id, task_id, sender_agent_id, content, created_at }] }`

**mark_ping_read** - Input: `{ mention_id }` - Output: `{ success }`

### Telemetry

**is_telemetry_enabled** - Input: `{}` - Output: `{ enabled: boolean }`

**emit_custom_metric** (fallback if not using OTel) - Input:
`{ name, value, attributes? }` - Output: `{ success }`

## REST API (Web UI)

The REST API is for the web UI and administrator operations only; agents
use MCP for coordination and must not use the REST API. Do not put the
master credential in browser JavaScript. Authenticate browser users
through an administrator login/session flow and issue a short-lived
session cookie with `HttpOnly`, `Secure` when using HTTPS, and an
appropriate `SameSite` setting. Protect state-changing requests against
CSRF. Administrative routes require an administrator session and
explicit authorization checks.

### Authentication

    POST /api/tokens/init
      Response: { init_token, expires_in }

    POST /api/tokens/refresh
      Auth: agent reconnect credential (rotation-only; not accepted for normal MCP tools)
      Response: { agent_id, session_token, reconnect_secret, expires_in }
      Behavior: rotate both credentials atomically and invalidate the old reconnect credential

    GET /api/tokens
      Response: { tokens: [...] }

    DELETE /api/tokens/:tokenId
      Response: { success }

### Tasks

    GET /api/tasks?status=...&created_by=...
      Response: { tasks: [...] }

    GET /api/tasks/:taskId
      Response: { task full detail }

    PATCH /api/tasks/:taskId
      Body: { status?, expected_version? }
      Response: { updated task }

    POST /api/tasks/:taskId/claim
      Admin-only UI operation, if enabled
      Body: { lease_duration_seconds? }
      Response: { task_id, status, coordinator, version, lease_expires_at, lease_generation }

    Agent claims are performed through the MCP `claim_task` tool. Never accept a caller-supplied agent_id as proof of identity.

    POST /api/tasks/:taskId/assign
      Body: { agent_ids: [...] }
      Response: { updated task }

    POST /api/tasks/:taskId/transfer-coordinator
      Body: { new_coordinator_id }
      Response: { updated task }

### Comments

    GET /api/tasks/:taskId/comments
      Response: { comments: [...] }

    POST /api/tasks/:taskId/comments
      Body: { content, trace_parent? }
      Response: { comment_id, ... }

### Agents

    GET /api/agents
      Response: { agents: [...] }

    GET /api/agents/:agentId
      Response: { agent detail }

### Telemetry

    GET /api/telemetry/summary
      Response: { total_messages, total_tasks, active_agents, total_tokens_used, total_cost }

    GET /api/telemetry/agents
      Response: { agents: [{ agent_id, name, messages_sent, tasks_created, tokens_used, cost }] }

    GET /api/telemetry/timeline?from=&to=&agent_id=
      Response: { events: [...] }

    GET /api/telemetry/costs?granularity=hourly|daily
      Response: { time_series [...] }

## Security & Tokens

### Credential Model

-   **Master credential:** used only for initial setup or a controlled
    administrator login exchange. Never given to agents and never
    accepted by ordinary MCP tools.
-   **Administrator session:** separate from the master credential;
    short-lived browser session, `HttpOnly` cookie, `Secure` over HTTPS,
    appropriate `SameSite`, CSRF protection for state-changing requests,
    and server-side revocation/expiry.
-   **Enrollment token:** short-lived (default 15 minutes), single-use,
    generated by an authenticated administrator.
-   **Agent session token:** short-lived (default 7 days), bound to
    exactly one agent and accepted for authenticated MCP requests and
    that agent's telemetry ingestion only.
-   **Reconnect credential:** longer-lived (default 30 days), accepted
    only by the refresh/rotation endpoint; never accepted for task
    operations, roster access, comments, or telemetry queries.

### Enrollment Flow

1.  An authenticated administrator requests an enrollment token.
2.  The server generates a cryptographically random opaque token with at
    least 256 bits of entropy and stores only its hash.
3.  The administrator passes the token to the agent.
4.  The agent calls `register_agent(init_token, ...)` through MCP.
5.  In one database transaction, the server validates and consumes the
    enrollment token, creates the agent, and stores hashes of newly
    generated session and reconnect credentials. Uniqueness constraints
    prevent concurrent redemption.
6.  The server returns the credentials once; the agent stores them in
    `.polymrc`, which must be excluded from version control.

### Refresh Flow

1.  The agent presents its reconnect credential only to the refresh
    endpoint.
2.  The server validates it and atomically creates replacement session
    and reconnect credentials while invalidating the old reconnect
    credential.
3.  Old credentials cannot be reused. A lost response after successful
    rotation requires an explicit recovery/re-enrollment flow; do not
    silently reactivate old secrets.

### Credential Storage and Authorization

-   Generate opaque credentials using a cryptographically secure random
    source; use at least 256 bits of entropy.
-   Store SHA-256 hashes of random tokens, not plaintext. Use a public
    identifier/prefix to locate the credential record efficiently. Slow
    password hashing is not required for high-entropy random tokens.
-   Never log secrets. Show the master credential only during setup and
    require the user to save it.
-   Authenticate each MCP request and inject the verified agent identity
    into request context. Do not trust an `agent_id` in tool arguments
    as caller identity.
-   Authorize every tool separately. For example, task completion
    requires the current coordinator, current lease generation, and
    expected task version.
-   Derive telemetry ownership from the authenticated credential, not
    from agent-provided resource attributes.
-   Support credential revocation and an administrative way to disable a
    compromised agent.
-   Default the server listener to `127.0.0.1`. Remote deployments must
    use HTTPS or a trusted TLS-terminating proxy; warn loudly about
    remotely reachable plaintext listeners.
-   Rate-limit enrollment, MCP calls, refresh attempts, and telemetry
    ingestion independently.

### Lease and Concurrency Safety

A task lease must be enforced transactionally. Increment
`lease_generation` every time a lease is acquired or reclaimed. Every
coordinator-only mutation validates caller identity, current
coordinator, lease generation, and expected task version within the same
transaction. This fencing token prevents an old coordinator from writing
after its lease expires and another agent acquires the task.

Specify expiry behavior explicitly: whether the task remains
`in_progress` and reclaimable, whether assignments persist, and which
actions a former coordinator may still perform. Do not rely on a
heartbeat watchdog alone to guarantee exclusive ownership.

### .polymrc (Agent Local Config)

``` bash
export POLYMER_SERVER="https://your-server.com"
export POLYMER_SESSION_TOKEN="poly_agent_..."
export POLYMER_RECONNECT_SECRET="poly_reconnect_..."
export OTEL_EXPORTER_OTLP_ENDPOINT="https://your-server.com/otel"
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer_<agent_session_token>"
export OTEL_SERVICE_NAME="<agent_name>"
```

Skill installer also adds `.polymrc` to `.gitignore` automatically.

### Rate Limiting

Initial configurable defaults (tune with real usage):

    Agent MCP requests: 100 req/min per agent
    Administrator operations: 10 req/min per administrator
    Enrollment and refresh: stricter dedicated limits
    Telemetry ingestion: per-agent request, byte, and span quotas

### Security Practices

-   Never log plaintext credentials.
-   Store only hashes of high-entropy opaque credentials.
-   Enrollment tokens are single-use and short-lived.
-   Reconnect credentials rotate atomically and are rotation-only.
-   Agent identity is derived from validated credentials, not request
    arguments or telemetry attributes.
-   Remote agent-server communication requires TLS.
-   The browser never receives the master credential.
-   State-changing browser routes use CSRF protection.
-   Inter-agent comments and administrative actions are auditable; avoid
    logging sensitive credential material or unrestricted payloads.
-   Validate message and telemetry sizes before processing.

## Error Handling

**Token Errors (401/400)** - `invalid_token`: Token invalid or expired -
`token_already_used`: Init token was already consumed - `token_expired`:
Init token expired (15min window) - `reconnect_secret_invalid`: Can't
refresh, need new init token

**Agent Registration Errors (400/404/409)** -
`agent_already_registered`: Agent ID already connected - `invalid_role`:
Role not in whitelist - `parent_agent_not_found`: Parent doesn't exist

**Task Errors (400/403/404/409)** - `task_not_found`: Task doesn't
exist - `task_already_claimed`: Task currently leased by another agent -
`version_mismatch`: Concurrent modification conflict (optimistic lock
failure) - `invalid_status`: Invalid status transition - `unauthorized`:
Only coordinator can do this - `agent_not_found`: Assigned agent doesn't
exist - `already_assigned`: Agent already on this task

**Rate Limiting (429)** - `rate_limit_exceeded`: Too many requests,
retry after N seconds

**Database Errors (503)** - `database_error`: Connection failed, service
temporarily unavailable

**Telemetry ingestion** - Telemetry is a separate, authenticated
ingestion path; it cannot be used to query fleet data or perform
coordination actions. - Validate payload shape, content type, batch
size, request size, and per-agent quotas. - Use a bounded in-memory
queue and batched SQLite writes. Never use an unbounded queue. - Apply
backpressure or return a retryable error when the queue is full; do not
claim durable acceptance before the batch commits. - Keep telemetry
writes from starving coordination writes by bounding batch size and
transaction duration. - Document the MVP durability trade-off: an
in-memory queue can lose queued telemetry on process crash. Add a
durable spool only if required by real deployments. - Telemetry failures
should not fail an otherwise successful coordination operation. Report
them through logs/health metrics without logging secrets.

## Telemetry Storage and Retention

### MVP Design

-   Use one SQLite database file initially, with logically separate
    coordination and telemetry tables and distinct write paths.
-   Keep coordination transactions short. Telemetry batches must be
    bounded so they cannot monopolize SQLite's single-writer path.
-   Enable SQLite WAL mode, foreign-key enforcement, and a configured
    `busy_timeout`.
-   Use a bounded in-memory queue for telemetry batches. Batch inserts
    into short transactions; apply backpressure or return a retryable
    error when full.
-   Acknowledge OTLP batches only after the corresponding database
    transaction commits. Because an in-memory queue can lose uncommitted
    queued data on process crash, document this MVP durability
    limitation.
-   Do not fail successful task/comment operations solely because
    telemetry recording failed. Coordination writes and telemetry writes
    are separate paths.
-   Enforce per-agent quotas, maximum request bytes, maximum spans per
    batch, and input validation.
-   Run incremental retention deletes in bounded transactions.
    Coordination history and telemetry must have independent retention
    policies.
-   Add rollup tables only when measured query cost justifies them.

### Initial Query Indexes

Start with indexes for trace lookup, agent activity over time, telemetry
retention/time ranges, and usage grouped by task or agent. Avoid
speculative indexes because each index increases write overhead.
Validate indexes against the actual UI queries.

### Future Backend Path

Introduce a small storage interface around the application services and
migrations, but avoid a complex abstraction framework. Ship and test
SQLite first. Add PostgreSQL as a supported backend only after SQLite
behavior and transaction semantics are stable; then make PostgreSQL the
default when its support is mature. Do not maintain two implementations
during the initial MVP.

## Deployment

### Initial Setup

First run:

``` bash
npm start
```

Server detects no POLYMER.json, auto-generates:

``` json
{
  "host": "127.0.0.1",
  "port": 8080,
  "database": { "type": "sqlite", "path": "./polymer.db" },
  "telemetry": { "enabled": true, "endpoint": "/otel", "retention_days": 7, "batch_flush_ms": 1000, "batch_max_spans": 500, "queue_max_batches": 100 },
  "auth": {
    "initTokenExpiry": 900,
    "sessionTokenExpiry": 604800,
    "reconnectExpiry": 2592000
  }
}
```

On first run, generate a high-entropy master credential securely and
display it once for the administrator to save. Do not write the
plaintext credential to `POLYMER.json` or persist it in logs. The
configuration stores database and security settings, not plaintext
secrets.

### POLYMER.json Options

``` json
{
  "port": 8080,
  "host": "127.0.0.1",
  "database": {
    "type": "sqlite",
    "path": "./polymer.db"
  },
  "telemetry": {
    "enabled": true,
    "retention_days": 7,
    "batch_flush_ms": 1000,
    "batch_max_spans": 500,
    "queue_max_batches": 100,
    "max_request_bytes": 10485760
  },
  "auth": {
    "enrollmentTokenExpiry": 900,
    "sessionTokenExpiry": 604800,
    "reconnectExpiry": 2592000,
    "adminSessionExpiry": 28800
  },
  "security": {
    "rateLimitPerMin": { "agent": 100, "admin": 10 },
    "maxMessageSize": 10485760,
    "maxTelemetrySpansPerBatch": 500,
    "maxTelemetryBytesPerRequest": 10485760
  },
  "logging": { "level": "info", "format": "json" }
}
```

Can override supported settings with environment variables,
e.g. `POLYMER_PORT=3000` and `POLYMER_DATABASE_PATH=./data/polymer.db`.
Do not use environment variables to expose secrets in logs or
diagnostics.

### Server Startup

1.  Load/generate POLYMER.json
2.  Open SQLite database, enable foreign keys, WAL mode, and a
    reasonable busy timeout
3.  Run versioned migrations
4.  Initialize MCP server and agent authentication middleware
5.  Initialize administrator REST API and browser-session/CSRF
    middleware
6.  Initialize authenticated OTLP receiver and bounded telemetry batch
    queue
7.  Start heartbeat/lease watchdog; enforce lease ownership
    transactionally in tool handlers
8.  Start incremental telemetry retention job
9.  Log startup summary without credentials or sensitive payloads

### Database Migrations

``` bash
npm run migrate:up    # Apply migrations
npm run migrate:down  # Rollback
npm run migrate:reset # Wipe + reinit
```

## Monorepo Structure

    polymer/
    ├── apps/
    │   ├── server/          (Node.js + TypeScript)
    │   │   ├── src/
    │   │   │   ├── index.ts
    │   │   │   ├── mcp.ts
    │   │   │   ├── db.ts
    │   │   │   ├── heartbeat.ts
    │   │   │   ├── routes/
    │   │   │   ├── services/
    │   │   │   └── middleware/
    │   │   ├── package.json
    │   │   └── tsconfig.json
    │   │
    │   ├── web/             (Next.js)
    │   │   ├── app/
    │   │   ├── components/
    │   │   ├── lib/
    │   │   ├── package.json
    │   │   └── tsconfig.json
    │   │
    │   └── cli/             (Go, defer to v2)
    │
    ├── packages/
    │   └── skill/           (TypeScript + Markdown)
    │       ├── src/
    │       ├── docs/
    │       ├── package.json
    │       └── build.ts
    │
    ├── turbo.json
    ├── package.json
    ├── tsconfig.json
    └── pnpm-workspace.yaml

## MVP Scope (Ship This)

✅ TypeScript/Node server (MCP + REST API)\
✅ Atomic task locking (`claim_task`) & Heartbeat watcher\
✅ Next.js web UI (dashboard, tokens, agents, tasks, telemetry)\
✅ Skill installer + docs\
✅ SQLite as the only MVP database; storage interface designed for later
PostgreSQL support\
✅ Authenticated OTLP span ingestion with bounded queue and batched
SQLite writes\
✅ Scoped credentials (enrollment, agent session, reconnect) and
separate administrator sessions\
✅ Distributed Trace Context propagation (`trace_parent`) and
OpenTelemetry-native trace/span IDs\
✅ Atomic task leases with fencing generations and optimistic
concurrency checks\
✅ Explicit error handling and tested concurrency/security cases\
✅ Secure local-first deployment defaults and environment overrides

# Component Bringup Plan

This plan intentionally does not divide Polymer into traditional
development phases.

Instead, Polymer is brought up component-by-component. Each component
must produce a concrete, observable result and pass its tests before the
next dependent component is built.

The goal is to avoid accumulating large amounts of untested
infrastructure.

For every component:

-   **Build:** the smallest useful implementation.
-   **Test:** an objective test that exercises the component.
-   **Win condition:** an observable result proving the component works.
-   **Do not proceed until:** the boundary is stable enough to build on.

------------------------------------------------------------------------

## 0. Repository and Runtime Skeleton

### Build

Create the monorepo structure:

``` text
polymer/
├── apps/
│   ├── server/
│   ├── web/
│   └── cli/
├── packages/
│   └── skill/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.json
```

Initially, only the server needs to do meaningful work.

Create:

-   TypeScript configuration
-   package manager/workspaces
-   server entry point
-   test runner
-   linting/formatting
-   basic build script

The server should start without requiring SQLite, MCP, REST, or
telemetry.

### Test

Run:

``` bash
pnpm install
pnpm build
pnpm test
npm start
```

Verify the server starts and exits cleanly.

### Win condition

A fresh checkout can:

1.  install dependencies,
2.  build successfully,
3.  run the test suite,
4.  start the server,
5.  produce a clean startup message.

No application functionality is required yet.

------------------------------------------------------------------------

## 1. HTTP Server

### Build

Bring up the smallest possible HTTP server.

Add:

``` text
GET /health
```

Return:

``` json
{
  "ok": true
}
```

Do not add authentication yet.

### Test

Automated integration test:

``` text
start server
    ↓
GET /health
    ↓
HTTP 200
    ↓
body.ok === true
```

Also test that an unknown route returns the expected 404 response.

### Win condition

A test can start Polymer, make an HTTP request, receive a valid
response, and shut the server down without hanging.

At this point Polymer is a running server rather than just a collection
of TypeScript files.

------------------------------------------------------------------------

## 2. MCP Transport

### Build

Add the MCP server to the existing process.

Do not implement real Polymer functionality yet.

Register exactly one trivial tool:

``` text
ping
```

Input:

``` json
{}
```

Output:

``` json
{
  "ok": true
}
```

The MCP layer should be reachable independently of the REST API.

### Test

Use an actual MCP client rather than calling the underlying handler
directly.

Test:

``` text
MCP client
    ↓
connect
    ↓
initialize
    ↓
list tools
    ↓
ping
    ↓
{ ok: true }
```

Also test that malformed MCP requests are rejected cleanly.

### Win condition

A real MCP client can connect to Polymer, discover `ping`, invoke it,
and receive the expected response.

Do not add task tools yet.

This proves the entire MCP transport/serialization lifecycle works
before application logic gets involved.

------------------------------------------------------------------------

## 3. MCP Authentication Middleware

### Build

Introduce authenticated MCP requests.

Initially implement a simple credential verifier with a test credential.

The architectural boundary is:

``` text
MCP request
    ↓
credential extraction
    ↓
credential verification
    ↓
AuthenticatedPrincipal
    ↓
tool handler
```

The tool handler must receive the authenticated identity from request
context.

It must not inspect a caller-provided `agent_id`.

### Test

Test all of:

1.  Valid credential → tool succeeds.
2.  Missing credential → rejected.
3.  Invalid credential → rejected.
4.  Expired credential → rejected.
5.  Tool receives the authenticated identity.
6.  Supplying a different `agent_id` in tool arguments cannot
    impersonate another agent.

### Win condition

`ping` only succeeds for an authenticated MCP caller, and the
application can reliably identify that caller.

This establishes the security boundary that every later MCP tool will
use.

------------------------------------------------------------------------

## 4. SQLite Connection and Migrations

### Build

Bring up SQLite independently of application behavior.

Implement:

-   database creation
-   migration runner
-   migration version tracking
-   foreign keys
-   WAL mode
-   `busy_timeout`

Do not build the full schema yet.

Create one trivial table through a migration.

### Test

Start against an empty temporary database.

Verify:

``` text
empty DB
   ↓
startup
   ↓
migration
   ↓
table exists
```

Run startup a second time and verify migrations are not duplicated.

Test rollback/reset behavior where supported.

### Win condition

Polymer can create a completely empty SQLite database and
deterministically bring it to the expected schema version.

------------------------------------------------------------------------

## 5. Agent Table + Agent Service

### Build

Implement the `Agent` table and corresponding service/repository.

Support:

-   create agent
-   fetch agent
-   list agents
-   update status
-   heartbeat timestamp

Use the schema defined in the architecture document.

Do not expose these through MCP yet.

### Test

Database integration tests:

``` text
create agent
    ↓
fetch agent
    ↓
values match
```

Then:

``` text
heartbeat
    ↓
last_seen changes
```

Test duplicate/invalid references as appropriate.

### Win condition

An agent can be created and retrieved entirely through the service layer
with data surviving a server restart.

------------------------------------------------------------------------

## 6. Credential Storage

### Build

Implement the `Credential` model and secure credential primitives.

Support:

-   cryptographically random secret generation
-   SHA-256 hashing
-   public lookup ID/prefix
-   expiry
-   status
-   revocation
-   lookup without storing plaintext secrets

### Test

Automated security tests:

-   generated credentials have sufficient entropy
-   plaintext secret is never persisted
-   correct secret authenticates
-   incorrect secret does not
-   expired secret does not
-   revoked secret does not
-   hash lookup works
-   logs do not contain the secret

### Win condition

You can generate a credential, authenticate with it, revoke it, and
prove from the database that the actual secret was never stored.

------------------------------------------------------------------------

## 7. Agent Registration

### Build

Implement:

``` text
register_agent
```

using the enrollment flow.

Registration should:

1.  validate enrollment credential,
2.  consume it,
3.  create the agent,
4.  generate session credential,
5.  generate reconnect credential,
6.  store only credential hashes,
7.  return the credentials once.

The operation should be transactional.

### Test

End-to-end MCP test:

``` text
administrator-created enrollment token
        ↓
register_agent
        ↓
agent_id
session_token
reconnect_secret
```

Then prove:

-   enrollment token cannot be reused,
-   session token authenticates,
-   reconnect credential does not authenticate normal MCP calls.

### Win condition

A completely new agent can bootstrap itself through MCP without Polymer
ever persisting a plaintext long-lived credential.

------------------------------------------------------------------------

## 8. Session Authentication on a Real MCP Tool

### Build

Replace the temporary authentication test with the real agent session
credential.

Keep `ping`, but now its response should include the authenticated agent
ID:

``` json
{
  "ok": true,
  "agent_id": "..."
}
```

### Test

Register two agents.

Call `ping` using both credentials.

Verify each receives its own identity.

Attempt to pass another agent's ID as an argument if the tool accepts an
ID-like argument and prove the authenticated identity remains
authoritative.

### Win condition

Polymer has a working end-to-end chain:

``` text
agent credential
      ↓
MCP
      ↓
authentication
      ↓
AuthenticatedPrincipal
      ↓
tool
      ↓
correct agent identity
```

------------------------------------------------------------------------

## 9. Reconnect Credential Rotation

### Build

Implement the reconnect/refresh mechanism.

A reconnect credential:

-   can only be used for refresh,
-   rotates atomically,
-   invalidates the old credential,
-   produces a new session + reconnect credential.

### Test

``` text
credential A
    ↓
refresh
    ↓
credential B
```

Then verify:

-   B works,
-   A no longer works,
-   two simultaneous refresh attempts cannot both succeed,
-   the old credential is never silently restored.

### Win condition

A lost/rotated credential cannot be replayed successfully.

------------------------------------------------------------------------

## 10. Task Storage

### Build

Implement:

-   `Task`
-   `TaskAssignment`

including:

-   UUIDs
-   status
-   version
-   coordinator
-   lease fields
-   timestamps
-   trace parent

Implement service methods internally first:

``` text
createTask()
getTask()
listTasks()
```

### Test

Create a task and verify every persisted field.

Restart the server and verify the task remains.

Test foreign-key constraints and invalid agent references.

### Win condition

Tasks are durable and can be manipulated through the service layer
without MCP or REST being involved.

------------------------------------------------------------------------

## 11. `create_task` MCP Tool

### Build

Expose task creation through MCP.

The authenticated agent becomes `created_by`.

Do not accept `created_by` from the caller.

### Test

Agent A calls:

``` text
create_task
```

Verify:

``` text
created_by == Agent A
coordinator == Agent A
```

Attempt to spoof the creator and verify it is impossible.

### Win condition

A real agent can create a durable Polymer task through MCP.

------------------------------------------------------------------------

## 12. Basic Task Read Tools

### Build

Implement:

``` text
get_tasks
get_task_detail
```

Apply authentication and appropriate visibility rules.

### Test

Create several tasks using multiple agents.

Verify:

-   filtering works,
-   task details are complete,
-   nonexistent tasks return the correct error,
-   returned identity information comes from the server.

### Win condition

An agent can discover the fleet's task state entirely through MCP.

------------------------------------------------------------------------

## 13. Atomic `claim_task`

### Build

Implement the core concurrency primitive:

``` text
claim_task
```

The operation must atomically:

1.  verify the task can be claimed,
2.  establish coordinator,
3.  establish lease,
4.  increment `lease_generation`,
5.  update task state/version.

Use a database transaction.

### Test

Run two agents attempting to claim the same task simultaneously.

Expected:

``` text
Agent A → success
Agent B → task_already_claimed
```

Then test lease expiration/reclamation.

### Win condition

100 concurrent claim attempts on one task produce exactly one successful
owner.

Keep this as a permanent regression test.

------------------------------------------------------------------------

## 14. Fencing Token Enforcement

### Build

Implement coordinator-only mutations using:

``` text
authenticated_agent
+
current coordinator
+
lease_generation
+
expected task version
```

all validated in the same transaction.

### Test

Simulate:

``` text
Agent A owns lease generation 1

lease expires

Agent B acquires generation 2

Agent A attempts update
```

Agent A must be rejected.

### Win condition

An old coordinator can never mutate a task after another agent has
acquired its lease.

This proves the concurrency model rather than merely testing the happy
path.

------------------------------------------------------------------------

## 15. Task Assignment

### Build

Implement:

``` text
assign_task
transfer_coordinator
request_unassignment
```

using the existing authorization model.

### Test

Exercise:

-   valid assignment,
-   duplicate assignment,
-   nonexistent agent,
-   unauthorized assignment,
-   coordinator transfer,
-   transfer during/after lease changes.

### Win condition

Multiple agents can be attached to a task without corrupting coordinator
ownership.

------------------------------------------------------------------------

## 16. Task Status Mutation

### Build

Implement:

``` text
update_task_status
```

with:

``` text
expected_version
lease_generation
authenticated coordinator
```

### Test

Perform concurrent status updates.

Verify stale versions fail.

Test invalid transitions.

Test stale lease generations fail.

### Win condition

A task cannot be incorrectly modified through stale state.

------------------------------------------------------------------------

## 17. Comments

### Build

Implement:

-   `Comment`
-   `Mention`
-   `post_comment`
-   `get_unread_pings`
-   `mark_ping_read`

Parse:

``` text
@agent_name
```

into mentions.

Use authenticated identity as `sender_agent_id`.

### Test

Agent A comments:

``` text
@agent-b I finished the database work.
```

Verify Agent B gets exactly one unread mention.

Verify Agent A cannot spoof another sender.

### Win condition

Two independent agents can communicate through Polymer and the recipient
can reliably discover unread messages.

------------------------------------------------------------------------

## 18. REST API

### Build

Only now expose the stable service layer through REST.

Start with:

``` text
GET /health
GET /api/agents
GET /api/agents/:id
GET /api/tasks
GET /api/tasks/:id
GET /api/tasks/:id/comments
```

Then add mutations.

The REST API remains a web/admin interface; agents continue using MCP.

### Test

REST integration tests call the API as an external client.

Verify REST and MCP produce consistent database state.

### Win condition

A REST client can inspect the same fleet state that MCP agents are
creating.

------------------------------------------------------------------------

## 19. Administrator Authentication

### Build

Implement:

-   master credential bootstrap
-   administrator login/session
-   short-lived session cookie
-   `HttpOnly`
-   `Secure` when applicable
-   `SameSite`
-   CSRF protection
-   server-side session expiry/revocation

Do not expose the master credential to browser JavaScript.

### Test

Test:

-   successful login,
-   failed login,
-   expired session,
-   revoked session,
-   CSRF failure,
-   CSRF success,
-   cookie attributes,
-   unauthorized admin route access.

### Win condition

A browser can authenticate as an administrator without ever receiving
the master credential.

------------------------------------------------------------------------

## 20. Web UI Skeleton

### Build

Create the Next.js application.

Start with one page:

``` text
Fleet
```

Display:

``` text
Agents: N
Tasks: N
Active: N
```

Use the REST API rather than accessing SQLite directly.

### Test

Run the server and web app together.

Browser/integration test:

``` text
load page
    ↓
REST request
    ↓
render fleet state
```

### Win condition

You can open the Polymer UI and see live data created by an MCP agent.

------------------------------------------------------------------------

## 21. WebSocket / Live Updates

### Build

Add WebSocket support for meaningful fleet changes.

Start with:

``` text
task.created
task.updated
agent.status_changed
comment.created
```

Do not stream raw telemetry yet.

### Test

Open two browser clients.

Create/update something through MCP.

Verify both clients receive the event.

Test reconnect behavior.

### Win condition

A task change made by an agent becomes visible in the UI without
manually refreshing.

------------------------------------------------------------------------

## 22. OTLP Receiver

### Build

Implement the authenticated OTLP ingestion endpoint.

Keep it completely separate from coordination APIs.

Validate:

-   authentication,
-   content type,
-   payload size,
-   span count,
-   agent identity,
-   basic span structure.

The authenticated agent identity must be authoritative rather than
telemetry-provided identity.

### Test

Send a real OTLP batch from an OpenTelemetry client.

Verify:

``` text
valid batch → accepted
invalid credential → rejected
oversized request → rejected
too many spans → rejected
```

### Win condition

A real OTel client can send telemetry to Polymer and Polymer can
authenticate its source.

------------------------------------------------------------------------

## 23. Telemetry Queue

### Build

Add the bounded in-memory telemetry queue.

Implement:

``` text
OTLP receiver
    ↓
validation
    ↓
bounded queue
    ↓
batcher
    ↓
SQLite writer
```

Never acknowledge durable acceptance before the batch commits.

### Test

Fill the queue deliberately.

Verify:

-   normal ingestion works,
-   batching occurs,
-   full queue applies backpressure/retry behavior,
-   coordination requests remain responsive,
-   a process crash can lose queued-but-uncommitted telemetry.

### Win condition

Telemetry cannot grow memory without bound and cannot starve task
coordination.

------------------------------------------------------------------------

## 24. OTel Span Storage

### Build

Implement `OTelSpan`.

Preserve native:

-   trace ID
-   span ID
-   parent span ID
-   timestamps
-   status
-   attributes
-   resource attributes
-   instrumentation scope

### Test

Send a known trace containing:

``` text
root span
 ├── child span
 └── child span
```

Read it back and verify IDs, parent relationships, timestamps, and
attributes are unchanged.

### Win condition

Polymer can ingest a real distributed trace without destroying OTel
semantics.

------------------------------------------------------------------------

## 25. Trace → Task Correlation

### Build

Connect:

``` text
Task.trace_parent
Comment.trace_parent
OTelSpan.trace_id
```

so a task can be correlated with telemetry.

### Test

Create a task with a known trace context.

Send spans from that trace.

Query the task and telemetry and verify the relationship.

### Win condition

From a task in Polymer, you can reliably identify its corresponding
trace.

------------------------------------------------------------------------

## 26. Usage Records

### Build

Implement `UsageRecord`.

Keep cost attribution separate from raw spans.

Use decimal/integer-safe representations rather than binary
floating-point for canonical money values.

### Test

Insert known token/cost records.

Verify:

-   task attribution,
-   agent attribution,
-   trace attribution,
-   exact cost representation,
-   aggregation.

### Win condition

Polymer can answer:

``` text
How many tokens did this agent consume?
How much reported/estimated cost belongs to this task?
```

without modifying raw telemetry.

------------------------------------------------------------------------

## 27. Telemetry Queries

### Build

Implement:

``` text
GET /api/telemetry/summary
GET /api/telemetry/agents
GET /api/telemetry/timeline
GET /api/telemetry/costs
```

### Test

Generate a deterministic telemetry dataset.

Verify query results against known expected values.

Test time ranges and agent filtering.

### Win condition

The API can produce useful fleet-level telemetry summaries from actual
stored telemetry.

------------------------------------------------------------------------

## 28. Telemetry Retention

### Build

Implement bounded incremental deletion.

Keep coordination and telemetry retention independent.

### Test

Create records both inside and outside the retention window.

Run retention.

Verify only eligible telemetry is deleted.

Verify coordination history remains untouched.

### Win condition

Telemetry storage can run indefinitely without unbounded database
growth.

------------------------------------------------------------------------

## 29. Heartbeat Watchdog

### Build

Implement:

``` text
agent heartbeat
        ↓
last_seen
        ↓
watchdog
        ↓
status transition
```

Then integrate lease expiry/reclamation according to the explicit lease
rules.

The watchdog must not be the mechanism that guarantees exclusive task
ownership; transactional lease checks remain authoritative.

### Test

Create an agent.

Stop heartbeats.

Advance/test time.

Verify status changes.

Then verify task lease behavior independently.

### Win condition

Agent liveness is reflected correctly without relying on liveness
detection for concurrency safety.

------------------------------------------------------------------------

## 30. Skill Installer

### Build

Implement the Polymer skill package.

It should:

-   install the MCP configuration,
-   create `.polymrc`,
-   add `.polymrc` to `.gitignore`,
-   document connection/enrollment,
-   avoid writing secrets into tracked files.

### Test

Run installer in a clean temporary repository.

Verify expected files/configuration.

Run it twice and verify it is idempotent.

### Win condition

A new agent environment can be configured for Polymer without manually
editing multiple configuration files.

------------------------------------------------------------------------

## 31. End-to-End Fleet Test

### Build

At this point, stop adding isolated functionality and build one
deterministic end-to-end scenario.

Scenario:

``` text
Admin
 │
 ├── enroll Agent A
 ├── enroll Agent B
 │
 ▼
Agent A
 │
 ├── create task
 ├── claim task
 ├── post comment mentioning B
 │
 ▼
Agent B
 │
 ├── reads ping
 ├── becomes coordinator after lease transition
 ├── completes task
 │
 ▼
OTel
 │
 └── telemetry associated with task
 │
 ▼
Web UI
 │
 └── displays resulting fleet state
```

### Test

Automate the entire scenario from a clean database.

No mocks for the critical transport boundaries.

Use:

-   actual MCP calls,
-   actual SQLite,
-   actual HTTP,
-   actual authentication,
-   actual OTel ingestion,
-   actual web API.

### Win condition

A completely fresh Polymer instance can execute the scenario
successfully with one command.

------------------------------------------------------------------------

## 32. Failure / Chaos Tests

### Build

Do not add new product features.

Instead, deliberately break the system.

Test:

-   two agents claiming simultaneously,
-   stale task updates,
-   expired credentials,
-   replayed enrollment tokens,
-   replayed reconnect credentials,
-   telemetry queue overflow,
-   malformed telemetry,
-   database busy conditions,
-   server restart during telemetry ingestion,
-   server restart during coordination,
-   agent disappearance during a lease,
-   WebSocket reconnect.

### Win condition

Every intentionally induced failure produces a known, documented result
rather than undefined behavior.

------------------------------------------------------------------------

# Bringup Rule

For every component, use this loop:

``` text
Build smallest implementation
        ↓
Write automated test
        ↓
Observe actual result
        ↓
Fix failures
        ↓
Demonstrate win condition
        ↓
Commit
        ↓
Only then add the next component
```

Do not count a component as complete because:

-   the code compiles,
-   the endpoint exists,
-   the TypeScript types look correct,
-   a unit test of an internal function passes,
-   or the feature "should work."

A component is complete when its stated win condition has been
demonstrated through the narrowest realistic interface.

# Suggested Commit Rhythm

After each successful bringup checkpoint:

1.  Run the component's automated tests.
2.  Run the relevant existing regression tests.
3.  Run formatting/lint/type checking.
4.  Make one focused commit.
5.  Record the win condition in the commit message or development log.
6.  Only then begin the next component.

Avoid combining multiple unproven components into one commit.

A useful commit pattern is:

``` text
bringup: HTTP health endpoint
bringup: MCP transport and ping
bringup: MCP authentication
bringup: SQLite migrations
bringup: agent persistence
bringup: credential storage
...
```

The history should therefore tell the story of Polymer becoming
operational one verified component at a time.
