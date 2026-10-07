---
name: polymer-security-review
description: Review credentials, sessions, CSRF, rate limits, and logging hygiene. Use on any diff touching auth, tokens, cookies, limits, or logs.
---

# Polymer Security Review

Source: design doc → Credential model, Storage and Authorization, Rate Limiting, Logging Rules, Deployment.

## Credential classes

- `master`: human-chosen, LOW entropy → scrypt (CSPRNG 128-bit salt, PHC string in `token_hash`, constant-time verify). Login-only at `POST /api/auth/login`; never in browser JS, never in MCP, never in logs.
- `init` OTP: 6-digit CSPRNG `crypto.randomInt(0,1000000)` zero-padded (~20 bits) → scrypt + per-token salt. 10-min TTL, single-use consume-on-verify. Lookup by `credential_id` (UUID, CSPRNG v4, never sequential) then constant-time compare. Failed guess never consumes, always counts against rate limit. Mint via `POST /api/tokens/init` (admin session + CSRF) returns code ONCE.
- Machine secrets (`agent_session` 7d, `agent_reconnect` 30d, `admin_session` 8h): ≥256-bit CSPRNG entropy, SHA-256 hash (slow hash NOT required). `public_id` lookup for session/reconnect; init tokens have no prefix.
- Never log/persist plaintext: no `master_credential`, OTP codes, session/reconnect secrets or hashes, CSRF tokens, `token_hash` values.

## Flows

- Register: validate + consume OTP + create agent + store session/reconnect HASHES only, one transaction. UNIQUE on agent name → `name_taken`.
- Refresh: reconnect Bearer at `POST /api/tokens/refresh` only; atomically mint replacement pair, invalidate old; replay → `reconnect_already_used` + security event (no secret material), require fresh init token. Rate limit 5/min per credential + global 60/min.
- Rotation: `POST /api/auth/rotate-master` atomically replaces hash, returns plaintext once, revokes ALL admin sessions + closes live WebSockets, writes `master.rotated` audit row.
- Disable cascade: all descendant credentials → `revoked`, statuses → `disabled`, bounded batches.
- Login: verify constant-time, mint fresh session id + 256-bit CSRF (ignore presented cookie — no fixation), `Set-Cookie __Host-polymer_admin`. Logout deletes server row, closes sockets, clears cookie with identical attributes.
- MCP identity: derived from validated credential into request context; never from `agent_id` args or telemetry attributes. Reconnect credential authenticates NOTHING except refresh.

## Rate limits (per plan defaults)

MCP 100/min/agent; admin 10/min; login 5/min/IP + global 30/min; OTP verify 10/min/IP + global 60/min atomic (not per-key); refresh 5/min/credential. Consume bucket BEFORE lookup/compare. Exceeded → `429 rate_limit_exceeded` + `retry_after`, never disguised. XFF only when `trusted_proxies` CIDRs configured — rightmost untrusted entry; leftmost never trusted.

## Logging rules (normative)

- FORBIDDEN: secret material; `init_token_id` on wrong-code guesses (log IP + `rate_limited`/`rejected` only).
- Security events (reconnect replay, used-token replay): `agent_id`/`credential_id`, IP, timestamp only.
- Audit `before`/`after`: task columns only (status, coordinator, version, generation, lease). Never comment bodies or telemetry blobs.
- Telemetry failures: span count + agent_id + reason. Never attributes.
- Listener defaults `127.0.0.1`; remote plaintext = loud warning; remote requires HTTPS/TLS proxy.

## What to flag

`Math.random`/modulo-biased OTP, sequential `credential_id`, SHA-256 for master/init, missing salt/PHC, plaintext storage, secret in logs/errors, reconnect accepted on normal tools, session token accepted on refresh route, missing CSRF on state-changing REST, sliding admin expiry, fixation (adopting presented cookie).
