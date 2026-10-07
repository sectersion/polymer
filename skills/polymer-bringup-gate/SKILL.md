---
name: polymer-bringup-gate
description: Gate any Polymer diff against its claimed bringup component. Verifies scope, route ownership, win condition, and commit hygiene.
---

# Polymer Bringup Gate

Source: `polymer_fleet_management_design_bringup.md` → Component Bringup Plan + Bringup Rule + Suggested Commit Rhythm.

## 1. Identify the claimed component

Ask: which component (0–32) does this diff claim? Reject review if the commit message doesn't say (`bringup: <component>` pattern). One component per commit — flag combined unproven components.

## 2. Scope check

- Only the claimed component's files change. Later-component routes/services must not appear except through a stated service-layer seam.
- Route ownership (exactly one owner each):
  - 1: `GET /health` · 2: MCP `ping` · 9: `POST /api/tokens/refresh`
  - 18: REST reads (`/api/agents*`, `/api/tasks*`, `GET /api/audit`)
  - 19: admin auth + mutations (`/api/auth/*`, `POST /api/tokens/init`, `GET/DELETE /api/tokens`, task claim/assign/transfer, `PATCH /api/tasks/:id`, `POST /api/tasks/:id/comments`, `POST /api/agents/:id/disable`)
  - 21: `GET /api/events` · 22: `POST <endpoint>/v1/traces` · 27: `GET /api/telemetry/*`
- Test seams allowed only where the plan names them: 7 (credential service mint), 14 (`__test_lease_write` behind `testSeams: true`), 18 (service-seeded admin session). Probe tools must never ship in production builds.

## 3. Win-condition check

Each component has an observable win — demand evidence, not compilation:

- 0: fresh `pnpm install, build, test, start`; startup message; clean SIGINT/SIGTERM exit 0
- 1: external `GET /health → {ok:true}` + 404 on unknown route, clean shutdown
- 2: real MCP client lists/invokes `ping → {ok:true}`; malformed requests rejected
- 3–9, 13–16: see concurrency + security skills
- 22–28: see telemetry skill
- 31: `pnpm e2e:fleet` from clean DB over real MCP/HTTP/SQLite/OTLP
- 32: each chaos case yields a documented error, never undefined behavior

A component is NOT done because it compiles, the endpoint exists, types look right, or an internal unit test passes. Require the narrowest realistic interface (real client, real transport).

## 4. Regression + hygiene

- Component's own tests pass; relevant prior regression tests still pass (esp. claim-concurrency test from 13 — permanent).
- `pnpm build, test, lint, typecheck, format:check` clean.
- Diff against remote is exactly the claimed commit(s); working tree clean.
- Commit message records the win condition.

## Verdict format

`PASS` / `CONDITIONAL` / `FAIL` + component number + which win-condition step was actually observed vs. asserted.
