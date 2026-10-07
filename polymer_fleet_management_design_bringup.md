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

### Terminology

Each agent in the fleet is called a **monomer** — a single unit that
links with others into larger structures (the fleet is the polymer).
"Agent" and "monomer" mean the same entity throughout this document.
The identifier stays `agent_id` on the wire, in MCP tools, in REST
routes, and in the database: domain language may evolve, stable
identifiers do not.

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
    - parent_agent_id (optional UUID) // for subagents; immutable, set only at creation
    - status (enum) // "connecting", "connected", "idle", "working", "error", "disconnected", "disabled"
    - heartbeat_timeout_seconds (int, default=300)
    - last_seen (timestamp)
    - connected_at (timestamp)
    - created_at (timestamp)

**Credential**

    - credential_id (UUID, CSPRNG random v4, never sequential or
    time-ordered; unguessability is a security premise for the
    init-token flow)
    - public_id (string, non-secret lookup prefix/identifier; null for
    init tokens, which are looked up by `credential_id` instead)
    - type ("master" | "init" | "agent_session" | "agent_reconnect" | "admin_session")
    - token_hash (string, hash of the secret; never plaintext. Algorithm
    depends on credential class (see Credential Storage and
    Authorization): human secrets and OTPs use scrypt; 256-bit opaque
    machine secrets use SHA-256. Parameters/salts are stored PHC-style
    in this column.)
    - agent_id (optional UUID, for agent credentials)
    - status ("active" | "used" | "revoked" | "expired")
    - created_at (timestamp)
    - expires_at (timestamp, nullable)
    - last_used_at (timestamp, nullable)
    - rotated_from_credential_id (optional UUID)

Generate secrets with a cryptographically secure random source.
Machine credentials (agent session, reconnect, admin session material)
are opaque with at least 256 bits of entropy and stored as SHA-256
hashes; slow password hashing is not required for high-entropy random
tokens. Two credential classes are explicitly excluded from that rule
and always use scrypt (CSPRNG 128-bit salt, PHC string in
`token_hash`, constant-time verify): the human-chosen `master`
credential (low entropy by nature) and the 6-digit `init` OTP
(enumerable ~20-bit space). Never log secrets. Keep the master
credential separate from agent credentials and administrator browser
sessions.

The init token is the deliberate exception to the 256-bit rule: it is a
6-digit numeric OTP (~20 bits, CSPRNG-generated, zero-padded) intended
only for human-transcribed first contact. Its weakness is compensated by
a 10-minute TTL, single-use consume-on-verify semantics, and strict
rate limits on the verification path (see Rate Limiting).

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

**AuditLog** (administrator bypass and security-event record)

    - audit_id (UUID)
    - actor_type ("admin_session" | "master" | "system")
    - actor_id (string, session/admin identifier; never secret material)
    - action (string, e.g. "task.claim.bypass", "task.status.bypass", "agent.disable", "master.rotated")
    - task_id (UUID, optional)
    - agent_id (UUID, optional)
    - before (JSON, optional)
    - after (JSON, optional)
    - created_at (timestamp)

Every admin lease-bypass task mutation writes exactly one row in the
same transaction as the mutation. A subtree disable writes one summary
row per cascade batch (`action: "agent.disable.batch"`, with
`disabled_count` and the batch's `disabled_agents` in `after`); small
subtrees therefore produce exactly one row. Audit rows follow the
coordination retention policy (indefinite in the MVP).

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
    - reported_cost_micro_usd (integer, optional; canonical money
    representation is integer micro-USD, never binary floating-point,
    so cost aggregates with plain SQL `SUM()`)
    - cost_source ("reported" | "unknown"; `"estimated"` is reserved for
    a future pricing engine and never emitted by the MVP)
    - recorded_at (timestamp)

Cost may be reported by an integration or estimated from usage and
pricing data; it is not necessarily authoritative billing data. Money
is integer micro-USD everywhere (`reported_cost_micro_usd`), never
binary floating-point.

### Usage Derivation (no separate ingestion path)

Usage rows are derived server-side from OTLP span attributes at
ingestion time, in the same batch transaction. Attribute mapping
(OpenTelemetry GenAI conventions, all optional; missing attributes
yield NULLs, never errors):

    span attribute `gen_ai.request.model` → UsageRecord.model
    span attribute `gen_ai.provider.name` → UsageRecord.provider
    span attribute `gen_ai.usage.input_tokens` → UsageRecord.input_tokens
    span attribute `gen_ai.usage.output_tokens` → UsageRecord.output_tokens
    span attribute `gen_ai.usage.cost_micro_usd` → UsageRecord.reported_cost_micro_usd

`agent_id` comes from the authenticated ingestion identity and
`trace_id` from the span, exactly like `OTelSpan`. `task_id` is
accepted from span attributes only when the authenticated agent is
assigned to or coordinates that task; otherwise it is stored as NULL
and a `telemetry.task_id_rejected` counter increments. Telemetry can
never claim work on a task the sender has no relation to. `cost_source` is
`"reported"` when the cost attribute is present, else `"unknown"`.
One usage row is written per span carrying at least one mapped usage
attribute. There is intentionally no `report_usage` tool in the MVP:
the OTLP batch is the single telemetry intake.

### Aggregation (exact formulas)

All sums treat NULL as 0. SQLite INTEGER is 63-bit signed (≈9.2×10¹⁸
micro-USD ≈ $9.2 trillion), so overflow is unreachable inside the
costs endpoint's 31-day maximum range.

    tokens_used (per agent) = SUM(input_tokens) + SUM(output_tokens)
    total_tokens_used       = SUM over all usage rows, same formula
    cost_micro_usd          = SUM(reported_cost_micro_usd)  // reported rows only;
                              unknown-cost rows contribute 0
    time_series bucket      = { bucket_start, cost_micro_usd } with the same SUM

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
CREATE INDEX idx_audit_task_time ON audit_log(task_id, created_at);
CREATE INDEX idx_otel_spans_trace ON otel_spans(trace_id);
CREATE INDEX idx_otel_spans_agent_start ON otel_spans(agent_id, start_time_unix_ns);
CREATE INDEX idx_otel_spans_start ON otel_spans(start_time_unix_ns);
CREATE INDEX idx_usage_task_time ON usage_records(task_id, recorded_at);
CREATE INDEX idx_usage_agent_time ON usage_records(agent_id, recorded_at);
```

## MCP Tools (Agents Call These)

### Agent Management

**register_agent** - Input:
`{ init_token_id, init_token, name, role, heartbeat_timeout_seconds? }` -
Output: `{ agent_id, session_token, reconnect_secret, expires_in, reconnect_expires_in }` -
Errors: `invalid_token`, `token_expired`, `token_already_used`, `name_taken`

Agent names are unique fleet-wide (UNIQUE constraint) so `@agent_name`
mentions resolve unambiguously. Roles are free-form by default;
`invalid_role` is returned only when the optional
`agentRolesAllowlist` config is set, in which case registration with a
role outside the list is rejected. This tool registers top-level agents
only and does not accept `parent_agent_id`; subagents are created
exclusively through `register_subagent`, so a parent link can never be
self-asserted.

**register_subagent** - Input:
`{ name, role, heartbeat_timeout_seconds? }` -
Auth: agent session token only (not init token, not reconnect credential) -
Output: `{ agent_id, parent_agent_id, session_token, reconnect_secret, expires_in, reconnect_expires_in }` -
Semantics: any authenticated agent may spawn a subagent. The server sets
`parent_agent_id` to the caller and ignores any caller-supplied parent;
spoofing another parent is impossible. The child's credentials are
returned once; the parent injects them into the child's environment
(process env, `.polymrc`) and launches it. Role whitelist and
fleet-wide name uniqueness apply. No fan-out or depth caps in the MVP:
the accepted control is admin disable with subtree cascade plus audit,
revisited when real usage demands limits. Spawn rate is still bounded
in practice by the per-agent MCP rate limit (100 req/min), which caps
how fast one compromised agent can fan out. Every creation is recorded
with parent and timestamp in the agents table, so anomalous fan-out is
visible to administrators before they reach for disable. -
Errors: `unauthorized`, `invalid_role`, `name_taken`

**send_heartbeat** - Input: `{}` - Output:
`{ success: true, timestamp }` - Errors: `unauthorized`,
`agent_not_found` -
The agent skill loop calls this every ~60s, well under the default
300s `heartbeat_timeout_seconds`. Nothing else feeds liveness.

**get_agent_roster** - Input: `{}` - Output:
`{ agents: [{ agent_id, name, role, status, last_seen, parent_agent_id }] }`

**get_agent_info** - Input: `{ agent_id }` - Output:
`{ agent_id, name, role, status, last_seen, connected_at, tasks_created, tasks_assigned }`

### Task Operations

**claim_task** (Atomic Lock Acquisition) - Input:
`{ task_id, lease_duration_seconds? }` - Output:
`{ task_id, title, status: "in_progress", coordinator, version, lease_expires_at, lease_generation }` -
Semantics: acquire the lease atomically in a database transaction;
increment `lease_generation` on each successful acquisition. The
returned `coordinator` always equals the caller. Claim matrix
(evaluated transactionally):
`to_do` + (unleased or expired) → success, status becomes `in_progress`;
`to_do` + live lease held by another → `task_already_claimed`;
`to_do` + live lease held by caller → success (renew: expiry extended,
`version` bumped, `lease_generation` unchanged, same state returned);
`in_progress` + expired/unleased → success (reclaim, new generation);
caller is coordinator + live lease → success (renew, same version-only
rule as above);
`failed` + (unleased or expired) → success, status becomes `in_progress`
with a new generation (this is the lease-expiry recovery path; the
explicit requeue path is `update_task_status` to `to_do` while the
lease is still live);
`failed` + live lease held by another → `task_already_claimed`;
`done` → `invalid_status`, always.
Transfer and assign always require a live lease held by the caller: after
expiry the successor reclaims via `claim_task` first, then assigns or
hands off. No task state is reachable only through admin bypass.
Coordinator-only mutations must validate the authenticated caller,
current lease generation, and expected task version in the same
transaction. - Errors: `task_already_claimed`, `task_not_found`,
`invalid_status`, `version_mismatch`

**create_task** - Input: `{ title, description?, trace_parent? }` -
Output:
`{ task_id, title, status, created_by, coordinator, assigned_to, version, lease_generation, lease_expires_at, trace_parent, created_at }` -
Semantics: the creator becomes coordinator with an initial lease
(`lease_generation: 1`, `lease_expires_at: now + lease_default_seconds`,
default 3600) while status stays `to_do`. No self-claim is needed; the
creator can mutate immediately, and others may claim only after expiry.
`assigned_to` is `[]` on creation (the creator is coordinator, not
assignee).

**get_tasks** - Input:
`{ status?, created_by?, assigned_to?, limit? }` - Output:
`{ tasks: [...] }` -
Pagination: `limit` defaults to 50, maximum 500. The MCP surface is
limit/offset-free by design (agents page with repeated filtered calls);
cursor pagination lives on the REST side only. Comment listings use
`get_comments`, below.

**get_task_detail** - Input: `{ task_id }` - Output:
`{ task_id, title, description, status, version, created_by, coordinator, lease_generation, lease_expires_at, trace_parent, assigned_to, comments: [...latest 20], has_more: bool, created_at, updated_at }` -
Full comment history goes through `get_comments`.

**update_task_status** - Input:
`{ task_id, status: "in_progress"|"done"|"failed"|"to_do", expected_version: int, lease_generation: int }` -
Output: `{ task_id, status, version, updated_at }` - Errors:
`invalid_status`, `unauthorized`, `task_not_found`, `version_mismatch` -
Semantics: requires the coordinator with a live lease (see Lease and
Concurrency Safety). Transition table (MCP and REST alike; `force`
overrides lease/version/generation but never this table):

    to_do → in_progress   claim_task / admin-claim only (never update/PATCH)
    in_progress → done     update / PATCH (force allowed)
    in_progress → failed   update / PATCH (force allowed)
    failed → to_do         update / PATCH, live lease required (force allowed)
    failed → in_progress   claim_task reclaim on unleased/expired only
    done → *               TERMINAL. Nothing leaves done, not even force.

Moving to `done` or `failed` clears the lease. `failed → to_do`
retry requires a live lease at call time (or admin force).

**assign_task** - Input:
`{ task_id, agent_ids: [string], expected_version: int, lease_generation: int }` -
Output: `{ task_id, assigned_to, version, lease_generation, updated_at }` - Errors:
`unauthorized`, `agent_not_found`, `already_assigned`,
`version_mismatch` -
Semantics: coordinator-only with a live lease; validates caller,
coordinator, generation, and version in the same transaction like all
coordinator mutations. Assign reports the current generation unchanged
and bumps `version` only: assignment is not an ownership-epoch change.

**transfer_coordinator** - Input:
`{ task_id, new_coordinator_id, expected_version: int, lease_generation: int, lease_duration_seconds? }` - Output:
`{ task_id, coordinator, version, lease_generation, lease_expires_at, updated_at }` -
Semantics: caller must be the current coordinator (or an administrator
via REST). The new coordinator must be a registered agent assigned to
the task. The transfer increments `lease_generation` (a new fencing
epoch) and bumps `version`, and renews the lease
(`lease_expires_at: now + lease_duration_seconds or the server
default`): the new coordinator inherits a usable lease rather than a
possibly already-expiring one, and any in-flight write from the old
coordinator is rejected on generation mismatch. - Errors:
`unauthorized`, `agent_not_found`, `task_not_found`,
`not_assigned`, `version_mismatch`

**request_unassignment** - Input: `{ task_id, reason? }` - Output:
`{ success, message }` -
Semantics: the caller must hold a `TaskAssignment` row on the task;
success deletes that row. The coordinator is not auto-notified; use a
comment for handoff context. Does not touch coordinator, lease, or
status. - Errors: `not_assigned`, `task_not_found`

### Communication

**post_comment** - Input: `{ task_id, content, trace_parent? }` -
Output:
`{ comment_id, task_id, sender_agent_id, content, mentions: [agent_ids], trace_parent, created_at }` -
Parsing: `@agent_name` in content creates mentions. A mention token is
`@` followed by `[A-Za-z0-9_-]+`; names resolve by exact,
case-sensitive match against unique fleet-wide agent names. Unknown
`@names` create no mention; the comment still posts. Concurrent
registrations racing on the same name resolve through the UNIQUE
constraint, and the loser receives `name_taken` (never a 500).

**get_unread_pings** - Input: `{}` - Output:
`{ pings: [{ mention_id, comment_id, task_id, sender_agent_id, content, created_at }] }` -
Auth: returns only the caller's own mentions.

**mark_ping_read** - Input: `{ mention_id }` - Output: `{ success }` -
Auth: the mention must belong to the caller. Another agent's
`mention_id` returns `not_found` (not `unauthorized`) to avoid
confirming its existence.

**get_comments** - Input: `{ task_id, limit?, cursor? }` - Output:
`{ comments: [...], next_cursor }` -
Pagination mirrors the REST list conventions (`limit` default 50, max
500). `get_task_detail` embeds only the latest 20 comments with a
`has_more` flag; full history goes through this tool.

### Telemetry

**is_telemetry_enabled** - Input: `{}` - Output: `{ enabled: boolean }` -
Source of truth is the server `telemetry.enabled` config flag.

Custom/non-OTel metrics are deferred: there is no generic metrics store
in the MVP, so no `emit_custom_metric` tool ships until a real
integration requires it.

## REST API (Web UI)

The REST API is for the web UI and administrator operations only; agents
use MCP for coordination and must not use the REST API. Do not put the
master credential in browser JavaScript. Authenticate browser users
through an administrator login/session flow and issue a short-lived
session cookie with `HttpOnly`, `Secure` when using HTTPS, and an
appropriate `SameSite` setting. Protect state-changing requests against
CSRF. Administrative routes require an administrator session and
explicit authorization checks. Admin task mutations bypass lease and
fencing checks (escape hatch for stuck leases), but are audit-logged
with actor, action, and before/after state.

### Authentication

All `expires_in` values are integer seconds. Responses carrying two
credentials report both: `expires_in` (the session token) and
`reconnect_expires_in` (the reconnect credential).

    POST /api/auth/login
      Body: { master_credential }
      Response: Set-Cookie admin session; { success, csrf_token }
      Behavior: verifies the master credential (constant-time compare against
        stored hash), then mints a fresh CSPRNG session id and CSRF token,
        ignoring any cookie the caller presented (no fixation: a planted
        cookie value is never adopted). Issues a short-lived session cookie. Rate-limit brutally:
        5 req/min per IP plus a server-global cap of 30/min; failed attempts are logged
        without credential material. This is the only route that accepts the
        master credential over HTTP.

    POST /api/auth/logout
      Auth: administrator session
      Response: { success }
      Behavior: delete the server-side session row, close the session's
        live WebSockets, and clear the cookie with attributes identical
        to how it was set.

    GET /api/auth/csrf
      Auth: administrator session
      Response: { csrf_token }
      Behavior: re-read the session's CSRF token (for pages loaded before login).

    POST /api/auth/rotate-master
      Auth: administrator session (+ CSRF)
      Response: { master_credential, rotated_at }
      Behavior: generate a new master credential, replace the stored hash
        atomically, return the plaintext once. Rotation revokes all live
        admin sessions and closes live WebSockets (a stolen session does
        not survive rotation). Rate-limit like login.

    POST /api/tokens/init
      Auth: administrator session only. The master credential is accepted
        exclusively at `POST /api/auth/login`; first-time and CLI flows
        log in first (cookie jar), then call this route.
      Response: { init_token_id, init_token: "042913" (string, zero-padded 6 digits),
        expires_in: 600, expires_at: "<iso8601>" }
      Behavior: mint a single-use init-token OTP bound to no agent. The plaintext
        code is returned once and never stored. The browser onboarding page calls
        this route with the admin session cookie, so the master credential never
        reaches browser JavaScript. The page renders the countdown from the
        server-provided `expires_at`, never a hardcoded duration. (The
        `600` in the example response is `initTokenExpiry` rendered, not
        a constant.)

    POST /api/tokens/refresh
      Auth: agent reconnect credential as `Authorization: Bearer <secret>`
        (rotation-only; not accepted for normal MCP tools)
      Body: {} (empty JSON object required; unknown fields ignored; identity comes from the credential)
      Response: { agent_id, session_token, reconnect_secret, expires_in, reconnect_expires_in }
      Errors: `reconnect_secret_invalid` (unknown), `reconnect_already_used` (replay; security event)
      Behavior: rotate both credentials atomically and invalidate the old reconnect credential.
        Rate-limit per credential (5 req/min) plus a server-global refresh cap of 60/min.

    GET /api/tokens
      Auth: administrator session
      Response: { tokens: [{ credential_id, public_id, type, status, agent_id?, created_at, expires_at, last_used_at }] }
      Note: metadata only. Never return `token_hash` or plaintext secrets here.

    DELETE /api/tokens/:credentialId
      Auth: administrator session (+ CSRF)
      Response: { success }
      Behavior: revoke a single credential (status → `revoked`). To disable an
        agent and its subtree, use `POST /api/agents/:agentId/disable`.

### List Conventions

Every REST list route (`/api/tasks`, `/api/tasks/:taskId/comments`,
`/api/tokens`, `/api/audit`, `/api/telemetry/timeline`) accepts
`?limit=&cursor=` and returns `{ ..., next_cursor }`. Defaults mirror
the MCP side: `limit` defaults to 50, maximum 500. Cursors are opaque
server-issued strings, never offsets.

### Cookie, Auth, and CSRF Contract

Admin session cookie is named `__Host-polymer_admin` (prefix enforces
`Secure`, `Path=/`, no `Domain`). Attributes: `HttpOnly; Secure;
SameSite=Lax; Path=/`. `Secure` is required whenever `host` is not a
loopback address or the server sits behind a TLS-terminating proxy;
plaintext remote listeners are already a loud-warning case and must
never set the cookie without `Secure`. Clearing uses identical
attributes. Absolute (non-sliding) 8h expiry (`adminSessionExpiry`).

CSRF tokens are 256-bit CSPRNG per session, minted at login, stored
in the session row, returned in the login response (and via
`GET /api/auth/csrf`). Clients send them as `X-CSRF-Token`, or as
`?csrf=` for the WebSocket upgrade only. Verified constant-time
against the session row; failure → `403 csrf_invalid` (see catalog).
Every state-changing REST route requires the session cookie AND a
CSRF token; every read-only route requires the session cookie alone.
The table (C = CSRF required):

    POST /api/auth/login            master credential in body; no session yet; rate-limited
    POST /api/auth/logout           session
    POST /api/auth/rotate-master    session + C
    POST /api/tokens/init           session + C
    GET  /api/tokens                session
    DELETE /api/tokens/:id          session + C
    POST /api/tokens/refresh        reconnect Bearer (no session, no CSRF: credential-in-header)
    GET  /api/agents*               session
    POST /api/agents/:id/disable    session + C
    GET  /api/tasks*                session
    POST /api/tasks/:id/*           session + C
    PATCH /api/tasks/:id            session + C
    POST /api/tasks/:id/comments    session + C
    GET  /api/audit                 session
    GET  /api/telemetry/*           session
    POST <endpoint>/v1/traces       agent session Bearer (no CSRF: credential-in-header)
    GET  /api/events                session cookie + ?csrf= + Origin check

### Error Catalog (MCP code → HTTP status on REST)

    invalid_token            401    unknown/wrong credential
    token_expired            400    correct init code, too late
    token_already_used        400    correct init code, replayed
    reconnect_secret_invalid  401    unknown reconnect credential
    reconnect_already_used    401    replayed reconnect (security event logged)
    unauthorized              403    authenticated but not permitted
    csrf_invalid              403    missing/wrong CSRF token
    not_found                 404    unknown id (also used cross-agent for pings: no existence oracle)
    task_not_found            404    unknown task
    agent_not_found           404    unknown agent
    name_taken                409    duplicate agent name (includes UNIQUE-race collisions)
    already_assigned          409    duplicate TaskAssignment row
    not_assigned              400    unassignment/transfer target not on task
    parent_disabled           403    subagent spawn under disabled/disabling parent
    task_already_claimed      409    live lease held by another
    version_mismatch          409    stale expected_version or lease_generation
    invalid_status            400    illegal transition or claim on done
    invalid_role              400    role outside agentRolesAllowlist (when set)
    rate_limit_exceeded       429    with retry_after; never disguised as another error
    database_error            503    connection/availability failure

### Tasks

    GET /api/tasks?status=&created_by=&assigned_to=&limit=&cursor=
      Response: { tasks: [...], next_cursor }

    GET /api/tasks/:taskId
      Response: { task full detail }

    PATCH /api/tasks/:taskId
      Auth: administrator session (+ CSRF)
      Body: { status?, expected_version, lease_generation, force: boolean (default false) }
      Response: { updated task }
      Behavior: `force: false` validates `expected_version` and
        `lease_generation` like the MCP tool. `force: true` skips lease,
        fencing, and version checks but
        still enforces transition legality; it bumps version and
        generation, preserves `lease_expires_at` and `coordinator`
        except that moving to `done`/`failed` clears the lease, and
        writes an audit row. There is no silent fallback to force.

    POST /api/tasks/:taskId/claim
      Auth: administrator session (+ CSRF)
      Enabled by `ui.adminClaimEnabled` (default true); when false the route returns 403.
      Body: { lease_duration_seconds? }
      Response: { task_id, status, coordinator, version, lease_expires_at, lease_generation }
      Behavior: keeps `coordinator` unchanged (admin has no agent identity
        and coordinator is never caller-supplied); sets `lease_expires_at`
        to now + duration (or `tasks.lease_default_seconds`); increments
        `lease_generation`; bumps `version`; writes an audit row with
        `actor_type: "admin_session"`. This is a lease reset, not an
        ownership change — use transfer routes to change owners.

    Agent claims are performed through the MCP `claim_task` tool. Never accept a caller-supplied agent_id as proof of identity.

    POST /api/tasks/:taskId/assign
      Auth: administrator session (+ CSRF)
      Body: { agent_ids: [...], expected_version, lease_generation, force: boolean (default false) }
      Response: { updated task }
      Behavior: normal path validates version and generation exactly like
        the MCP tool (unleased tasks validate against the generation
        returned by reads, per the COALESCE rule). `force: true` bypasses
        (no live lease required),
        bumps version and generation, and writes an audit row.

    POST /api/tasks/:taskId/transfer-coordinator
      Auth: administrator session (+ CSRF)
      Body: { new_coordinator_id, expected_version, lease_generation, force: boolean (default false) }
      Response: { updated task }
      Behavior: same normal/force contract as assign; force needs no live
        lease, renews the lease, and writes an audit row.

### Comments

    GET /api/tasks/:taskId/comments?limit=&cursor=
      Response: { comments: [...], next_cursor }

    POST /api/tasks/:taskId/comments
      Auth: administrator session (+ CSRF)
      Body: { content, trace_parent? }
      Response: { comment_id, ... }
      Behavior: `sender_type` is always `"human"` with identity from the
        session; process `@mentions` exactly like the MCP tool.

### Agents

    GET /api/agents
      Response: { agents: [...] }

    GET /api/agents/:agentId
      Response: { agent detail }

    POST /api/agents/:agentId/disable
      Auth: administrator session (+ CSRF)
      Response: { success, disabled_count, complete: bool }
      Behavior: idempotent disable job over a frozen subtree. Starting
        the job freezes creation under it: `register_subagent` with a
        disabled (or disable-in-progress) parent fails with
        `parent_disabled`, checked in the same transaction as the
        insert, so concurrent spawns cannot escape the enumerated set.
        Descendants are walked by stable snapshot cursor in bounded
        batches (500/txn), each batch transactional with one
        `agent.disable.batch` audit row. Crash or 503 between batches
        is safe: retry the same call until `complete: true`; completed
        batches are skipped. Callers must poll/retry until
        `complete: true` before assuming the subtree is dead.

### Telemetry

    GET /api/telemetry/summary
      Response: { total_comments, total_tasks, active_agents, total_tokens_used, total_cost_micro_usd }
      Note: `total_comments` is `COUNT(comments)`. All money fields are
        integer micro-USD.

    GET /api/telemetry/agents
      Response: { agents: [{ agent_id, name, comments_sent, tasks_created, tokens_used, cost_micro_usd }] }

    GET /api/telemetry/timeline?from=&to=&agent_id=
      Response: { events: [...], next_cursor }
      Query contract: `from`/`to` are ISO-8601 UTC, `from` inclusive,
        `to` exclusive; default range is the last 24h; maximum range
        31 days; uniform list conventions apply.

    GET /api/telemetry/costs?granularity=hourly|daily
      Response: { time_series: [{ bucket_start, cost_micro_usd }] }
      Query contract: buckets align to UTC hour/day boundaries;
        missing buckets are zero-filled; same 31-day maximum range.

### OTLP Ingestion

    POST <telemetry.endpoint>/v1/traces (default `/otel/v1/traces`)
      Auth: agent session token as `Authorization: Bearer <token>`
      Content-Types: `application/x-protobuf` (preferred), `application/json`
      Limits: `max_request_bytes`, `max_spans_per_batch` (tie to
        `telemetry.max_request_bytes`, `telemetry.batch_max_spans`),
        per-agent quotas
      Responses: `200` accepted into the bounded queue (see durability
        note); `400` malformed payload; `401` bad credential; `413`
        over byte/span limits; `429` queue full, retry with `retry_after`;
        `503` database unavailable.
      Note: OTLP/HTTP clients append `/v1/traces` to the configured
        base URL automatically, so `.polymrc` sets the base
        (`https://server/otel`) while the server routes the full path.

### Audit

    GET /api/audit?task_id=&limit=&cursor=
      Auth: administrator session
      Response: { entries: [...], next_cursor }
      Behavior: read-only. Uniform list conventions apply (defined above
        under List Conventions).

### Web UI Page Map

Every page below is backed exclusively by the routes above. All pages
except Login require an administrator session; unauthenticated visits
redirect to Login. State-changing forms carry the CSRF token (see
component 19) and a Logout button calls `POST /api/auth/logout`.

-   **Login** → `POST /api/auth/login`. Username-free: one password
    field for the master credential. Never stores or displays the
    credential.
-   **Fleet** (dashboard) → agents + tasks endpoints now; summary
    cards (tokens, cost) are added with the component-27 telemetry
    endpoints, not before.
-   **Onboarding** → `POST /api/tokens/init`. "Mint init token" button
    renders the 6-digit OTP inside a copy-paste prompt for the new
    agent. Shows expiry countdown (10 min); a used/expired OTP is
    never reshown.
-   **Agents** → `GET /api/agents`, agent detail. Shows status,
    parent/children links, tasks. Disable button (with confirm) calls
    `POST /api/agents/:agentId/disable` and reports how many agents in
    the subtree were affected.
-   **Tasks** → task list/detail/comments endpoints. Normal reads for
    everyone; admin override affordances (claim, assign, transfer,
    status patch) labeled as lease-bypassing and audit-logged.
    Human comments post with `sender_type: "human"`.
-   **Tokens** → `GET /api/tokens` metadata table (`public_id`, type,
    status, bound agent, expiry). No secret material is ever rendered.
    Revoke button per row → `DELETE /api/tokens/:credentialId`.
    "Rotate master" affordance (confirm dialog, new credential shown
    once) → `POST /api/auth/rotate-master`.
-   **Telemetry** → summary, agents, timeline, costs endpoints. Built
    after component 27 lands the query endpoints, not before.
-   Live updates: Fleet, Agents, and Tasks subscribe to
    `GET /api/events` with `cursor` resume; on socket loss they fall
    back to 30s polling until the socket re-establishes.

## Security & Tokens

### Credential Model

-   **Master credential:** used only for initial setup or a controlled
    administrator login exchange. Never given to agents and never
    accepted by ordinary MCP tools.
-   **Administrator session:** separate from the master credential;
    short-lived browser session, `HttpOnly` cookie, `Secure` over HTTPS,
    appropriate `SameSite`, CSRF protection for state-changing requests,
    and server-side revocation/expiry.
-   **Init token:** 6-digit numeric OTP, short-lived (default 10
    minutes, `initTokenExpiry: 600`), single-use, minted by an
    authenticated administrator via `POST /api/tokens/init`. It
    authenticates exactly one `register_agent` MCP call, which exchanges
    it for the agent's session and reconnect credentials. Generate with
    a CSPRNG (`crypto.randomInt(0, 1000000)`, never `Math.random` or
    biased modulo). The 6-digit space is enumerable, so OTPs get a
    per-token 128-bit salt and a slow hash (scrypt), unlike the
    high-entropy credentials. Mint returns a `token_id`
    (`credential_id`) alongside the code; registration sends both, and
    the server looks up the single row by ID before comparing in
    constant time. Never log the code.
-   **Agent session token:** short-lived (default 7 days), bound to
    exactly one agent and accepted for authenticated MCP requests and
    that agent's telemetry ingestion only.
-   **Reconnect credential:** longer-lived (default 30 days), accepted
    only by the refresh/rotation endpoint; never accepted for task
    operations, roster access, comments, or telemetry queries.

### Init Token & Registration Flow

1.  An authenticated administrator (admin session; obtained via
    `POST /api/auth/login` for first-time and CLI flows) calls
    `POST /api/tokens/init`.
2.  The server generates a 6-digit OTP from a CSPRNG and stores only its
    scrypt hash (per-token salt) with a 10-minute expiry.
3.  The onboarding page renders the OTP inside a copy-paste prompt the
    administrator hands to the agent (chat message, QR, etc.).
4.  The agent calls `register_agent(init_token_id, init_token, ...)` through MCP.
5.  In one database transaction, the server validates and consumes the
    init token, creates the agent, and stores hashes of newly
    generated session and reconnect credentials. Uniqueness constraints
    prevent concurrent redemption; a failed OTP guess does NOT consume
    the token, but counts against the verification rate limit.
6.  The server returns the credentials once; the agent stores them in
    `.polymrc`, which must be excluded from version control.

### Refresh Flow

1.  The agent presents its reconnect credential only to the refresh
    endpoint.
2.  The server validates it and atomically creates replacement session
    and reconnect credentials while invalidating the old reconnect
    credential.
3.  Old credentials cannot be reused. A lost response after successful
    rotation requires an explicit recovery/re-registration flow (a fresh
    init token); do not
    silently reactivate old secrets.

### Credential Storage and Authorization

-   Generate opaque machine credentials using a cryptographically secure random
    source; use at least 256 bits of entropy, stored as SHA-256 hashes.
    `master` and `init` credentials always use scrypt instead (see Data Model).
-   Store hashes, not plaintext. Use a public
    identifier/prefix to locate high-entropy credential records efficiently
    (`credential_id` lookup for init OTPs, which have no prefix). Slow
    password hashing is not required for high-entropy random tokens, and
    is required for `master` and `init` classes.
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
    compromised agent. Disabling an agent cascades to its entire
    subtree: every descendant's credentials move to `revoked` and every
    descendant's status moves to `disabled`, in bounded batches.
    Children hold independent credentials for daily operation, but
    revocation is recursive by design so a compromised parent cannot
    leave live children behind.
-   Default the server listener to `127.0.0.1`. Remote deployments must
    use HTTPS or a trusted TLS-terminating proxy; warn loudly about
    remotely reachable plaintext listeners.
-   Rate-limit init-token minting, MCP calls, refresh attempts, and telemetry
    ingestion independently.

### Visibility and Mutation Authority

Reads are fleet-wide; writes are coordinator-gated:

-   Any authenticated agent may read all agents, tasks, comments, and
    mentions. There are no per-task read ACLs in the MVP.
-   `claim_task`: any authenticated agent, iff the task is unleased or
    its lease has expired.
-   `update_task_status`, `assign_task`, `transfer_coordinator`:
    current coordinator only (administrator override via REST only).
-   `request_unassignment`: the assigned agent itself.
-   `post_comment`: any authenticated agent on any task; sender identity
    always comes from the authenticated principal.
-   `get_unread_pings` / `mark_ping_read`: the mentioned agent only;
    agents cannot read or clear another agent's pings.

### Lease and Concurrency Safety

A task lease must be enforced transactionally. Increment
`lease_generation` on every ownership-epoch change: claim by a new
owner, reclaim, and coordinator transfer. Renew (same coordinator,
live lease) extends expiry and bumps `version` only, never the
generation, so a coordinator's in-flight writes are not invalidated
by its own renewal. Every
coordinator-only mutation validates caller identity, current
coordinator, lease generation, and expected task version within the same
transaction. This fencing token prevents an old coordinator from writing
after its lease expires and another agent acquires the task.

Specify expiry behavior explicitly: whether the task remains
`in_progress` and reclaimable, whether assignments persist, and which
actions a former coordinator may still perform. Do not rely on a
heartbeat watchdog alone to guarantee exclusive ownership.

MVP expiry rules: on expiry the task remains `in_progress` and becomes
claimable; assignments persist; the former coordinator becomes
read-only on that task. Every coordinator-only mutation requires a
live lease (`lease_expires_at > now`) validated in the same
transaction as identity, coordinator, generation, and version. Expiry
itself is lazy (evaluated on access/claim); the watchdog updates agent
liveness only and never confers ownership. Liveness checks use
`COALESCE(lease_expires_at, 0)`: a NULL lease reads as expired-zero,
i.e. immediately claimable, so SQLite three-valued logic can never
hide a releasable task.

Disabling an agent releases its task leases: every task it coordinates
keeps its `coordinator` value for history (rendered with its disabled
state in `get_task_detail`) but gets `lease_expires_at: null` with an
incremented `lease_generation`, making it immediately claimable. Assignments persist. "Disabled" means unauthenticated: revoked
credentials cannot read anything, so the fleet-wide read rule applies
only to authenticated agents. The subtree cascade freezes creation first
(`parent_disabled` on spawns under a disabling parent), then runs in bounded
batches (default 500 agents per transaction) over a stable snapshot cursor
so a large subtree cannot wedge SQLite's single-writer path against telemetry
batches; the disable endpoint reports `{ disabled_count, complete }` per call
and callers retry until `complete: true`.

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
    Init-token mint: administrator limits above
    Init-token verification (`register_agent` with an OTP): 10 req/min per IP
      plus a server-global cap (default 60/min); failed guesses never consume the token.
      Rate-limit key is the socket remote address by default. When
      `trusted_proxies` (explicit CIDR list) is configured, the key is
      the rightmost `X-Forwarded-For` entry outside the trusted ranges;
      a leftmost entry is never trusted (spoofable). An attacker rotating
      XFF behind a trusted proxy still hits the server-global caps,
      which are enforced on an atomic counter, not per-key state.
      The bucket is consumed before any token lookup or comparison, so
      attackers cannot probe codes faster than the bucket allows.
      Distinct failure codes (`invalid_token` vs `token_expired` /
      `token_already_used`) are kept deliberately: the lookup key is an
      unguessable UUID, and a "correct but dead" code confers no
      capability, so the residual oracle (confirming an ID exists) has
      no exploit path within a 10-minute token lifetime. Exceeded buckets
      return `429 rate_limit_exceeded`
      with `retry_after`, never `invalid_token`.
    Refresh: 5 req/min per credential
    Telemetry ingestion: per-agent request, byte, and span quotas

### Security Practices

-   Never log plaintext credentials.
-   Store only hashes of high-entropy opaque credentials (and of init-token OTPs).
-   Init tokens are single-use and short-lived (10 minutes).
-   Reconnect credentials rotate atomically and are rotation-only.
-   Agent identity is derived from validated credentials, not request
    arguments or telemetry attributes.
-   Remote agent-server communication requires TLS.
-   The browser never receives the master credential.
-   State-changing browser routes use CSRF protection.
-   Inter-agent comments and administrative actions are auditable; avoid
    logging sensitive credential material or unrestricted payloads.
-   Validate message and telemetry sizes before processing.

### Logging Rules (normative)

-   Never log: `master_credential`, init OTP codes, session/reconnect
    secrets or hashes, CSRF tokens, `token_hash` values.
-   Wrong-code OTP guesses: logging `init_token_id` is FORBIDDEN (it
    feeds the validity oracle); log IP + bucket outcome
    (`rate_limited` / `rejected`) only.
-   Security events (replayed reconnect, used-token replay): log
    `agent_id`/`credential_id`, IP, timestamp. No secret material.
-   Audit `before`/`after` is limited to task columns (status,
    coordinator, version, generation, lease). Never comment bodies,
    never telemetry blobs.
-   Telemetry validation failures: log span count, agent_id, and
    rejection reason. Never span attributes or resource attributes
    (they may carry user data).

## Error Handling

**Token Errors (401/400)** - `invalid_token`: unknown `init_token_id`
or wrong code (a failed guess never consumes the token, but always
counts against the verification rate limit; bad guesses are
indistinguishable from unknown IDs to avoid oracles) -
`token_already_used`: Init token was already consumed (correct code,
replayed) - `token_expired`: Init token expired (10min window; correct
code, too late) - `reconnect_secret_invalid`: unknown reconnect
credential, need new init token - `reconnect_already_used`: replay of a
rotated reconnect credential; correct secret, already rotated. Treat as
a possible loss/theft signal: log a security event (no secret material)
and require a fresh init token.

**Agent Registration Errors (400/404/409)** -
`name_taken`: Agent name already in use (names are fleet-wide unique) -
`invalid_role`: Role not in `agentRolesAllowlist`, when configured

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
queue and batched SQLite writes. Never use an unbounded queue. - A
`200` means validated and enqueued, NOT committed: a process crash
loses queued-but-uncommitted telemetry. This is documented behavior,
not a failure mode; responses never imply durability. - Apply
backpressure with `429` + `retry_after` when the queue is full. - Keep telemetry
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
-   Enable SQLite WAL mode, foreign-key enforcement, and
    `busy_timeout: 5000` ms. No single transaction may exceed 500 rows
    written (cascade batches and telemetry batches alike); larger work
    is split across transactions with backoff + retry on `SQLITE_BUSY`.
-   Use a bounded in-memory queue for telemetry batches. Batch inserts
    into short transactions; apply backpressure or return a retryable
    error when full.
-   `200` acknowledges validation + enqueue, never the commit. Because
    an in-memory queue can lose uncommitted queued data on process
    crash, the MVP durability contract is: at-most-once across crashes.
    Add a durable spool only if required by real deployments.
-   Do not fail successful task/comment operations solely because
    telemetry recording failed. Coordination writes and telemetry writes
    are separate paths.
-   Enforce per-agent quotas, maximum request bytes, maximum spans per
    batch, and input validation.
-   Run incremental retention deletes in bounded transactions.
    Coordination history and telemetry must have independent retention
    policies. MVP: telemetry keeps `retention_days` (default 7);
    coordination history is retained indefinitely until a measured need
    defines its policy.
-   Add rollup tables only when measured query cost justifies them.

### Initial Query Indexes

Start with indexes for trace lookup, agent activity over time, telemetry
retention/time ranges, and usage grouped by task or agent. Avoid
speculative indexes because each index increases write overhead.
Validate indexes against the actual UI queries.

### Future Backend Path

Introduce a small storage interface around the application services and
migrations, but avoid a complex abstraction framework. Ship and test
SQLite first. No PostgreSQL code ships in the MVP. Add PostgreSQL as a
supported backend only after SQLite
behavior and transaction semantics are stable; then make PostgreSQL the
default when its support is mature. At that point reconsider Kysely
(query builder, stays close to SQL) for the two-dialect code; never a
full ORM over the fencing transactions. Do not maintain two implementations
during the initial MVP.

## Deployment

### Initial Setup

First run:

``` bash
pnpm start
```

Server detects no POLYMER.json, auto-generates:

``` json
{
  "host": "127.0.0.1",
  "port": 8080,
  "database": { "type": "sqlite", "path": "./polymer.db" },
  "telemetry": { "enabled": true, "endpoint": "/otel", "retention_days": 7, "batch_flush_ms": 1000, "batch_max_spans": 500, "queue_max_batches": 100 },
  "auth": {
    "initTokenExpiry": 600,
    "sessionTokenExpiry": 604800,
    "reconnectExpiry": 2592000,
    "adminSessionExpiry": 28800
  }
}
```

On first run, generate a high-entropy master credential securely and
display it once for the administrator to save. Do not write the
plaintext credential to `POLYMER.json` or persist it in logs. The
configuration stores database and security settings, not plaintext
secrets. Only the scrypt hash of the master credential is persisted,
as a `type: "master"` row in the credentials table (`agent_id: null`).
Rotate it via an authenticated admin session:
`POST /api/auth/rotate-master` returns a new master credential once
and invalidates the old hash atomically; the operation writes an
`master.rotated` audit row.

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
    "initTokenExpiry": 600,
    "sessionTokenExpiry": 604800,
    "reconnectExpiry": 2592000,
    "adminSessionExpiry": 28800
  },
  "security": {
    "rateLimitPerMin": { "agent": 100, "admin": 10 },
    "maxMessageSize": 10485760
  },
  "tasks": { "lease_default_seconds": 3600 },
  "agentRolesAllowlist": null,
  "trusted_proxies": [],
  "testSeams": false,
  "ui": { "adminClaimEnabled": true },
  "logging": { "level": "info", "format": "json" }
}
```

Can override supported settings with environment variables,
e.g. `POLYMER_PORT=3000` and `POLYMER_DATABASE_PATH=./data/polymer.db`.
Do not use environment variables to expose secrets in logs or
diagnostics.

### Configuration Reference (normative)

Units matter: durations are **seconds**, sizes are **bytes**, unless
the key name says otherwise. `null` means unset/open.

    host: string, default "127.0.0.1"
    port: int, default 8080
    database.type: "sqlite" (MVP only)
    database.path: string, default "./polymer.db"
    telemetry.enabled: bool, default true
    telemetry.endpoint: string (base path), default "/otel" (full ingest path is <endpoint>/v1/traces)
    telemetry.retention_days: int, default 7
    telemetry.batch_flush_ms: int (milliseconds), default 1000
    telemetry.batch_max_spans: int, default 500
    telemetry.queue_max_batches: int, default 100
    telemetry.max_request_bytes: bytes, default 10485760
    auth.initTokenExpiry: seconds, default 600
    auth.sessionTokenExpiry: seconds, default 604800 (7 days)
    auth.reconnectExpiry: seconds, default 2592000 (30 days)
    auth.adminSessionExpiry: seconds, default 28800 (8h, absolute, non-sliding)
    security.rateLimitPerMin.agent: int, default 100
    security.rateLimitPerMin.admin: int, default 10
    security.maxMessageSize: bytes, default 10485760
    tasks.lease_default_seconds: seconds, default 3600
    agentRolesAllowlist: null (open) or string[] (invalid_role otherwise)
    trusted_proxies: CIDR[] (empty = socket address always; entries enable XFF processing)
    testSeams: bool, default false (test-only MCP probe tools exist only when true)
    ui.adminClaimEnabled: bool, default true

Both JSON examples above must match this table; where they show a
subset, omitted keys take these defaults.

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
7.  Start the agent-liveness watchdog (flips agent status on missed
    heartbeats; never touches task ownership) and, separately, an
    optional lease-expiry notifier (emits events/metrics only; all
    ownership decisions stay in the tool-handler transactions)
8.  Start incremental telemetry retention job
9.  Log startup summary without credentials or sensitive payloads

### Database Migrations

``` bash
pnpm migrate:up    # Apply migrations
pnpm migrate:down  # Rollback
pnpm migrate:reset # Wipe + reinit
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
    │   └── cli/             (Go, defer to v2; not built in the MVP)
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
✅ Scoped credentials (6-digit init-token OTP, agent session, reconnect) and
separate administrator sessions\
✅ Distributed Trace Context propagation (`trace_parent`) and
OpenTelemetry-native trace/span IDs\
✅ Atomic task leases with fencing generations and optimistic
concurrency checks\
✅ Explicit error handling and tested concurrency/security cases\
✅ Secure local-first deployment defaults and environment overrides

# Component Bringup Plan

### Route-to-Component Map

Every network route is owned by exactly one component. No component
may test a route owned by a later one except through a stated
service-layer seam.

-   1: `GET /health`
-   2: MCP transport (`ping`)
-   9: `POST /api/tokens/refresh` (rotation logic + HTTP binding)
-   18: REST reads — `/api/agents`, `/api/agents/:id`,
    `/api/tasks`, `/api/tasks/:id`, `/api/tasks/:id/comments`,
    `GET /api/audit`
-   19: admin auth + admin mutations — `/api/auth/login`,
    `/api/auth/logout`, `/api/auth/csrf`, `/api/auth/rotate-master`,
    `POST /api/tokens/init`, `GET/DELETE /api/tokens`,
    `POST /api/tasks/:id/claim`, `POST /api/tasks/:id/assign`,
    `POST /api/tasks/:id/transfer-coordinator`,
    `PATCH /api/tasks/:id`, `POST /api/tasks/:id/comments`,
    `POST /api/agents/:id/disable`
-   21: `GET /api/events` (WebSocket upgrade)
-   22: `POST <telemetry.endpoint>/v1/traces` (OTLP ingestion)
-   27: `GET /api/telemetry/*` (summary, agents, timeline, costs)

Test seams: component 7 mints init tokens through the credential
service directly (the component-19 HTTP route must call the same
service function). Component 18 exercises REST reads with a
service-seeded admin session; bypass/audit behavior is asserted in
component 19, not 18.

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
pnpm start
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

Add the MCP server to the existing process over Streamable HTTP (remote
fleets are the target; `.polymrc` already assumes an HTTPS server URL).

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
Single process, shared port, distinct paths (MCP, REST, OTLP, WS).

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

-   database creation via `better-sqlite3` (synchronous API suits the
    single-writer + transaction model) or `node:sqlite`
-   raw SQL in named, reviewed statements; no ORM/query builder in the
    MVP (revisit Kysely, not an ORM, if/when PostgreSQL lands — the
    fencing transactions must stay hand-readable)
-   hand-rolled versioned `.sql` migrations with a version table; no
    migration framework in the MVP
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

Do not expose these through MCP yet. The service layer is
unauthenticated-internal at this stage; authentication attaches in
components 7-8 and liveness in component 29.

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
-   `type: "init"` rows store a scrypt/PHC hash, never 64-hex SHA-256;
    `master` likewise; machine credentials store SHA-256
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

using the init-token flow.

Registration should:

1.  validate init-token OTP (constant-time hash compare, rate-limited),
2.  consume it,
3.  create the agent,
4.  generate session credential,
5.  generate reconnect credential,
6.  store only credential hashes,
7.  return the credentials once.

The operation should be transactional.

### Test

Test seam: the REST mint route does not exist yet at this stage, so
tests mint init tokens through the credential service directly
(insert the salted scrypt hash + 10-minute expiry, receive
`init_token_id`). The component-19 HTTP route must call the same
service function.

End-to-end MCP test:

``` text
administrator-minted 6-digit init token
        ↓
register_agent
        ↓
agent_id
session_token
reconnect_secret
```

Then prove:

-   init token cannot be reused,
-   expired init token is rejected,
-   >600 parallel guesses across many source IPs (exceeding one token's
    lifetime budget) still all fail after the token is consumed or
    expired, proving the global cap is atomic and not per-key state,
-   session token authenticates,
-   reconnect credential does not authenticate normal MCP calls.

Then the subagent path, using Agent A's session token:
``` text
Agent A calls register_subagent
        ↓
child agent_id, child credentials
        ↓
child calls ping → authenticated as itself, parent_agent_id == A
```

Then prove:

-   a duplicate name is rejected with `name_taken`,
-   no caller-supplied parent can override or spoof `parent_agent_id`,
-   an init token cannot call `register_subagent`, and a session token
    cannot call `register_agent`.

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

Implement the reconnect/refresh mechanism, logic plus its HTTP
binding (`POST /api/tokens/refresh`; the HTTP server already exists
from component 1, so no new transport work is needed).

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
-   trace parent (stored opaque here; interpreted and queried in
    component 25)

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

Apply authentication and the fleet-wide read rule: any authenticated
agent can read all tasks, mutations stay coordinator-gated.

### Test

Create several tasks using multiple agents.

Verify:

-   filtering works,
-   task details are complete,
-   an agent can read tasks created by other agents,
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

Then test lease expiration/reclamation, plus the matrix edges:
`to_do` + live lease held by another → `task_already_claimed`;
own live lease → renew (version bumped, generation unchanged);
`failed` + expired → claim succeeds into `in_progress`;
`done` → `invalid_status` always.

### Win condition

100 concurrent claim attempts on one task produce exactly one successful
owner.

Keep this as a permanent regression test.

------------------------------------------------------------------------

## 14. Fencing Token Enforcement

### Build

Implement the shared transactional guard all coordinator mutations
will use:

``` text
assertCoordinatorLease(task_id, caller, lease_generation, expected_version)
```

validated in a single transaction. Real tools adopt it in components
15-16; this component proves it in isolation through a test-only MCP
tool `__test_lease_write { task_id, lease_generation, expected_version }`
that runs a no-op write through the guard. The probe exists only when
`testSeams: true` is set in config and is never present in production
builds — same seam pattern as components 7 and 18.

### Test

Simulate through the probe tool (real tools adopt the same guard in
components 15-16):

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
-   coordinator transfer to an assigned agent,
-   transfer increments `lease_generation` and rejects the old
    coordinator's in-flight writes,
-   transfer to an unassigned agent is rejected,
-   transfer requires a live lease: after expiry the successor reclaims
    via `claim_task` first (transfer itself is never the recovery path),
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

Agent A comments (exact registered name `agent-b`):

``` text
@agent-b I finished the database work.
```

Verify Agent B gets exactly one unread mention.

Verify Agent A cannot spoof another sender.

Verify `@Agent-B` (wrong case) and `@nobody` create no mention.

Race two concurrent registrations on the same name; exactly one
succeeds and the loser gets `name_taken`.

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

Reads only; mutations belong to component 19.

The REST API remains a web/admin interface; agents continue using MCP.

### Test

REST integration tests call the API as an external client, using a
service-seeded admin session (login itself is built in component 19).

Verify REST and MCP produce consistent database state.

### Win condition

A REST client can inspect the same fleet state that MCP agents are
creating.

------------------------------------------------------------------------

## 19. Administrator Authentication

### Build

Implement:

-   master credential bootstrap
-   administrator login/logout routes (`POST /api/auth/login`,
    `POST /api/auth/logout`)
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
-   master rotation revokes all live admin sessions and live WebSockets,
    verified at REST level here (session rows gone, REST calls 401);
    the socket-close half is asserted in component 21, which owns the
    WebSocket transport,
-   every admin bypass mutation (claim, assign, transfer, PATCH) writes
    exactly one audit row readable via `GET /api/audit`,
-   normal-path mutations reject stale `expected_version` /
    `lease_generation` and missing CSRF (403),
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

Create the Next.js application. Build the pages in the Web UI Page Map
that the existing backend supports: Fleet, Login, Onboarding, Agents
(with disable), Tasks (with admin override affordances), Tokens.
Telemetry pages wait for component 27.

### Web UI Stack (normative)

-   Next.js App Router + TypeScript. Server Components fetch REST with
    the session cookie forwarded; client islands only for live regions.
    `(auth)/login` vs `(console)/*` route groups; `middleware.ts`
    enforces the session check + Login redirect.
-   Tailwind CSS v4 (CSS-first tokens) + `clsx` / `tailwind-merge` +
    `class-variance-authority`. No bespoke stylesheets beyond tokens.
-   shadcn/ui on Radix primitives (dialog, dropdown, tooltip, etc.),
    vendored copy-paste, themed via CSS vars.
-   GitHub-clean light-first aesthetic (`next-themes`, light default):
    Primer-inspired surfaces (`#f6f8fa` canvas, white cards, `#d0d7de`
    hairlines, `#0969da` accent), 6-8px radii, system font stack for
    prose with mono reserved for IDs/hashes/timestamps, status dots
    (green idle, blue working, red error, gray disabled). A dark scheme
    rides the same tokens via `next-themes` but is not the MVP design
    target.
-   Restrained liquid glass on chrome, not content: sticky header,
    sidebar, command palette, dialogs, and toasts use translucent fills
    + `backdrop-blur` + soft layered shadows; data surfaces (tables,
    cards, charts, waterfall) stay solid for density and readability.
    Text always sits on sufficient contrast; blur is depth cueing, never
    a readability tax.
-   Task board drag-and-drop via `@dnd-kit`. Admin drops across columns
    go through the PATCH/force contract with an inline audit notice.
-   Trace waterfall is custom-built (bars layout, ~small component),
    entered from a task's `trace_parent` link. No chart lib renders
    waterfalls; do not force one to.
-   Telemetry charts (costs, tokens, timeline) via Tremor
    (area/bar/line + KPI cards).
-   Dense tables (agents, tokens, audit) via TanStack Table.
-   Command palette (`cmdk`): jump to task/agent, mint token, disable,
    force-claim. Toasts via sonner.
-   Live regions share one `useEvents` hook over `GET /api/events`
    with cursor resume and 30s poll fallback (per Page Map).

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

Counts come from the agents/tasks endpoints only at this stage; the
telemetry summary numbers are wired in with component 27.

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

Add WebSocket support for meaningful fleet changes. WebSocket connections
require the administrator session cookie and a validated `Origin`
header (the browser CSRF posture applies to the upgrade request).

Endpoint: `GET /api/events` (upgrade). Browsers cannot set custom
headers on a WebSocket upgrade, so the handshake is: session cookie
(sent automatically) plus the CSRF token as a `?csrf=` query parameter,
validated against the session like any state-changing request, plus a
server `Origin` allowlist check. Failure closes with code 4401. Events
use the envelope `{ event_id, type, at, data }`; clients resume with
`/api/events?cursor=<event_id>&csrf=<token>` and the server replays
missed events from the (bounded) buffer, then streams live. The server
keeps a live-socket registry: logout, disable, credential revocation,
or master rotation closes affected sockets immediately (same
transaction/obligation as the session-row change, not eventually).
The 60s revalidation is a backstop for missed events and crash
recovery only, never the primary revocation path. Component 21 tests use a
real browser-capable WS client performing this handshake.

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

On rotation/disable/logout, assert live sockets close with 4401
(component 19 asserts the session-row half; this component asserts the
socket half).

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

`200` acknowledges validation + enqueue only, never the commit
(at-most-once across crashes); use `429` + `retry_after` on a full
queue. The crash test below asserts the documented loss.

### Test

Fill the queue deliberately.

Verify:

-   normal ingestion works,
-   batching occurs,
-   full queue applies backpressure/retry behavior,
-   coordination requests remain responsive,
-   a process crash loses queued-but-uncommitted telemetry (assert the
    documented loss: enqueue, kill before flush, verify absence after
    restart — this test documents the durability contract).

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

Money is integer micro-USD (`reported_cost_micro_usd`); no
floating-point in the canonical path.

### Test

Send OTLP batches carrying the mapped `gen_ai.*` attributes (see Usage
Derivation) plus a batch with none (must yield spans but zero usage
rows).

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
How much reported cost belongs to this task?
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

Then build the Telemetry UI pages from the Web UI Page Map against
these endpoints (deterministic dataset above doubles as the fixture).

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

Implement two strictly separated jobs, and nothing else:

``` text
job 1: agent heartbeat → last_seen → status transition (liveness only)
job 2: lease-expiry notifier → emits events/metrics only, writes nothing
```

Liveness transition table (liveness only; ownership untouched):

    any heartbeat received              → `idle` (or keep `working` if the
                                          agent holds a live lease; pick
                                          per implementation, document it)
    now - last_seen > timeout           → `disconnected`
    heartbeat on `disabled` agent       → rejected `unauthorized`, no change
    `disabled`                          → never auto-cleared, only via
                                          re-onboarding a fresh agent

Ownership decisions live exclusively in the tool-handler transactions
(claim/update/assign/transfer). The watchdog must never mutate
`coordinator`, `lease_expires_at`, or `lease_generation`; there is no
"reclamation" step here, lazy or otherwise.

### Test

Create an agent.

Stop heartbeats.

Advance/test time.

Verify status changes.

Then assert the negative: after expiry with no claimant, the task row's
`coordinator`, `lease_expires_at`, and `lease_generation` are
byte-identical to before (watchdog wrote nothing), while a subsequent
`claim_task` succeeds.

Then verify task lease behavior independently through the tools.

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
-   document connection/registration,
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
 ├── onboard Agent A (init token)
 ├── onboard Agent B (init token)
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

No mocks for the critical transport boundaries. The skill installer
from component 30 is used to configure every test agent (run it into a
temporary directory per agent and use the resulting config); if the
installer cannot serve the E2E harness, that is a component-30 defect,
not grounds for hand-rolled config.

The one-command entrypoint is `pnpm e2e:fleet`, which boots a fresh
server on a temporary database, runs the scenario, and tears down.

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
-   replayed init tokens,
-   replayed reconnect credentials,
-   telemetry queue overflow,
-   malformed telemetry,
-   database busy conditions,
-   server restart during telemetry ingestion,
-   server restart during coordination,
-   agent disappearance during a lease,
-   disable of a 1000+ agent subtree during a telemetry flood, with a
    p95 coordination-latency assertion (coordination stays responsive),
-   admin disable of a parent mid-lease (verify the whole subtree's
    credentials are revoked and in-flight child writes fail),
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

# Parking Lot (post-MVP, decided deferrals)

Not built, not forgotten. Promoting anything here requires its own
mini-design, not a drive-by.

-   **Subagent fan-out caps** (`maxSubagentsPerParent`, fleet cap):
    MVP runs uncapped with rate-bounded spawning + disable-cascade as
    the control. Add caps when real usage shows the need.
-   **Push scheduling**: agents pull work in this design. Any
    push/dispatch model is a v2 feature with its own authority story.
-   **Durable telemetry spool**: only if real deployments reject the
    at-most-once-across-crashes contract.
-   **Generic metrics store / custom metrics**: only when a real
    integration requires it.
-   **`estimated` cost source**: reserved for a future pricing engine.
-   **Coordination retention policy**: indefinite until measured need.
-   **PostgreSQL backend, Go CLI, OTLP metrics, span-events table,
    rollup tables**: per their in-doc conditions.
-   **Dark-mode design target**: tokens support it; MVP designs
    light-first.
-   **MCP request body size cap**: the component-2 `/mcp` body reader
    buffers without a limit (localhost-only bringup). Cap it (e.g. 1 MiB
    + `413`) alongside `security.maxMessageSize` enforcement.
