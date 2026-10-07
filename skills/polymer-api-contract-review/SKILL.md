---
name: polymer-api-contract-review
description: Review MCP tools and REST routes against the design-doc contracts. Use on any diff touching tools, routes, errors, or pagination.
---

# Polymer API Contract Review

Source: design doc → Data Model, MCP Tools, REST API, Error Catalog, List Conventions.

## MCP tools

- `register_agent {init_token_id, init_token, name, role, heartbeat_timeout_seconds?}` → errors `invalid_token, token_expired, token_already_used, name_taken`. Top-level only; never accepts `parent_agent_id`. `register_subagent` takes no parent — server sets it from caller; auth = session token only.
- `claim_task {task_id, lease_duration_seconds?}` returns full lease block (`coordinator == caller`, `version`, `lease_expires_at`, `lease_generation`).
- `create_task` sets creator = coordinator, `lease_generation: 1`, `lease_expires_at = now + lease_default_seconds (3600)`, `assigned_to: []`.
- `update_task_status {task_id, status, expected_version, lease_generation}`; `assign_task` (bumps `version` only, generation unchanged); `transfer_coordinator` (new coordinator must be assigned; increments generation, renews lease).
- `get_tasks` limit default 50/max 500, no offset/cursor on MCP. `get_task_detail` embeds latest 20 comments + `has_more`. `get_comments {task_id, limit?, cursor?}` for full history.
- `post_comment` mention token = `@[A-Za-z0-9_-]+`, exact case-sensitive match; unknown names post without mention; UNIQUE race → loser gets `name_taken` never 500.
- `get_unread_pings`/`mark_ping_read`: caller-only; чужой `mention_id` → `not_found` (not `unauthorized`).
- No `report_usage`, no `emit_custom_metric` in MVP. `is_telemetry_enabled` reads `telemetry.enabled`.

## REST

- Agents use MCP only; browser uses REST with admin session. Master credential accepted at exactly one route: `POST /api/auth/login`.
- `POST /api/tokens/refresh`: reconnect Bearer only, body `{}`, rotates both credentials atomically; errors `reconnect_secret_invalid / reconnect_already_used`.
- Admin mutations (`PATCH /api/tasks/:id`, `POST .../claim|assign|transfer-coordinator|comments`, `POST /api/agents/:id/disable`, `DELETE /api/tokens/:id`, `POST /api/auth/rotate-master`, `POST /api/tokens/init`) require session cookie + `X-CSRF-Token` (or `?csrf=` for WS upgrade only). Reads require session cookie alone. Cookie name `__Host-polymer_admin`, `HttpOnly; Secure (non-loopback); SameSite=Lax; Path=/`, absolute 8h expiry.
- `force: true` skips lease/version/generation but NEVER the status transition table; `done` is terminal even for force. Every bypass writes exactly one audit row in the same transaction (disable batches: one `agent.disable.batch` row per batch).
- `POST /api/tasks/:id/claim` keeps `coordinator` unchanged, resets lease, gated by `ui.adminClaimEnabled`.
- List routes (`/api/tasks`, `.../comments`, `/api/tokens`, `/api/audit`, `/api/telemetry/timeline`) use `?limit=&cursor=` (default 50, max 500), return `{..., next_cursor}` with opaque server cursors.

## Errors

Map MCP code → HTTP exactly: `invalid_token 401, token_expired 400, token_already_used 400, reconnect_secret_invalid 401, reconnect_already_used 401, unauthorized 403, csrf_invalid 403, not_found 404, task_not_found 404, agent_not_found 404, name_taken 409, already_assigned 409, not_assigned 400, parent_disabled 403, task_already_claimed 409, version_mismatch 409, invalid_status 400, invalid_role 400, rate_limit_exceeded 429 (+retry_after), database_error 503`. Flag any disguised 429 or missing `retry_after`.

## What to flag

Caller-supplied identity (`agent_id` as proof), caller-supplied `parent_agent_id`/`coordinator`, missing `expected_version`/`lease_generation` on coordinator mutations, plaintext secrets in `GET /api/tokens`, hardcoded OTP durations (use server `expires_at`), `Secure`-less cookie on non-loopback.
