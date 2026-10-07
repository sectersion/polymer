---
name: polymer-concurrency-review
description: Review task leases, fencing tokens, claim matrix, and status transitions. Use on any diff touching tasks, assignments, watchdog, or disable.
---

# Polymer Concurrency Review

Source: design doc → Claim matrix, Lease and Concurrency Safety, Task/Mention/Audit entities.

## Invariants

- `lease_generation` increments on every ownership-epoch change only: claim by new owner, reclaim, coordinator transfer, admin claim/force, disable-lease-release. Renew (same coordinator, live lease) extends expiry + bumps `version`, generation UNCHANGED.
- Every coordinator mutation (`update_task_status`, `assign_task`, `transfer_coordinator`) validates caller == coordinator + live lease (`lease_expires_at > now`, NULL reads as expired via `COALESCE(...,0)`) + `lease_generation` + `expected_version` in ONE transaction.
- Expiry is lazy (evaluated on access/claim). Task stays `in_progress`, assignments persist, former coordinator becomes read-only. No background job confers ownership.

## Claim matrix (transactional)

- `to_do` + unleased/expired → success → `in_progress`, new generation
- `to_do` + live lease held by another → `task_already_claimed`
- `to_do`/`in_progress` + live lease held by caller → renew (expiry extended, `version` bumped, generation unchanged)
- `in_progress` + expired/unleased → success (reclaim, new generation)
- `failed` + unleased/expired → success → `in_progress` (lease-expiry recovery path)
- `failed` + live lease held by another → `task_already_claimed`
- `done` → `invalid_status` always

## Status transitions (MCP and REST identical)

- `to_do → in_progress`: `claim_task`/admin-claim ONLY, never update/PATCH
- `in_progress → done|failed`: update/PATCH (force allowed); clears lease
- `failed → to_do`: update/PATCH, live lease required (force allowed)
- `failed → in_progress`: `claim_task` reclaim on unleased/expired only
- `done → *`: TERMINAL, even force

Transfer requires live lease held by caller (or admin force); target must hold a `TaskAssignment` row; transfer renews lease (`now + duration or default`). `assign_task` reports generation unchanged. `request_unassignment` deletes caller's row only; touches nothing else.

## Watchdog separation

Liveness job flips agent status on missed heartbeats (`last_seen` vs `heartbeat_timeout_seconds` default 300) and NEVER mutates `coordinator`/`lease_expires_at`/`lease_generation`. Lease-expiry notifier emits events/metrics only, writes nothing. Prove the negative: after expiry with no claimant, task row bytes identical; subsequent `claim_task` succeeds.

## Disable

Freeze creation first (`register_subagent` under disabled/disabling parent → `parent_disabled` in same insert txn), then bounded batches (500/txn) over stable snapshot cursor with one `agent.disable.batch` audit row per batch; retry until `complete: true`. Disabled tasks keep `coordinator` for history, get `lease_expires_at: null` + incremented generation (immediately claimable). Disabled credentials authenticate nothing (fleet-wide reads apply to authenticated agents only).

## What to flag

Missing transaction around guard checks, generation bump on renew or missing bump on transfer/reclaim, `COALESCE` omission on NULL leases, watchdog writing task columns, transfer to unassigned agent, `done` resurrection, 100-concurrent-claim regression test absent.
