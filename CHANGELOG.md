# Changelog — hand-written summaries per release, newest first.

# Tagged releases: https://github.com/sectersion/polymer/releases

## 0.1.0

First tagged release. Fleet management and observability for autonomous
multi-agent workflows: an agent-side MCP daemon, a coordination server
(SQLite-backed), and a Next.js admin console.

### Agent side

- **MCP daemon** (`packages/skill` installer, ESM entry): tools for task
  claim/assign/transfer, comments, lease lifecycle, and token refresh —
  identity always comes from validated credentials, never callers.
- **Self-registration**: agents enroll out-of-band, mint credentials via
  a one-time registration token, rotate silently.

### Coordination server (`@polymer/server`)

- **Task leases with fencing tokens**: claim-concurrency safe; a stale
  lease holder cannot reapply a write past a newer fence. Watchdog reaps
  expired leases.
- **REST API** with pagination and a documented error catalog
  (`GET /health`, `/api/agents*`, `/api/tasks*`, `/api/events`,
  `/api/telemetry/*`, `/api/audit`).
- **OTel intake** (`POST <endpoint>/v1/traces`): trace/span-native IDs,
  queue-backed ingestion with retention; token usage recorded per agent
  in integer micro-USD.
- **SQLite persistence**: WAL, forward-only migrations; identity is
  repository-level state, not per-request args.

### Admin console (`@polymer/web`)

- Fleet, Agents, Tasks, Tokens and Telemetry views with live e2e smoke
  (Playwright) run in CI.
- Session auth for admins with refresh-token flow.

### Operations & CI

- `pnpm e2e:fleet` — the proof step: full fleet scenario over real
  MCP/HTTP/SQLite/OTLP from a clean database.
- GHCR images on every merge to `main` (`:latest` + `:sha`); `v*` tags
  also publish `:<version>`.
- Coverage is report-only by design: no threshold, a per-file delta
  comment on every PR.
