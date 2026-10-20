# Contributing to Polymer

New here? This is the whole path: clone → verify → pick an issue → open a PR.
The normative spec is `polymer_fleet_management_design_bringup.md` — it wins
on any conflict. Day-to-day workflow lives in `AGENTS.md`.

## Quickstart

Prerequisites: Node ≥ 22, `pnpm` 12.

```sh
pnpm install && pnpm build
```

Run the seeded demo (built stack with a seeded fleet):

```sh
pnpm demo
```

Or start the server directly:

```sh
pnpm start
```

Config: `POLYMER.json`, env `POLYMER_PORT`, `POLYMER_HOST`.

## Verify

Run in this order — it mirrors CI (`.github/workflows/ci.yml`):

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm format:check
```

Then tests, scoped first:

```sh
pnpm --filter @polymer/server test   # or @polymer/web, @polymer/skill
pnpm test                            # full suite
```

If your diff touches server routes, MCP, or telemetry, finish with the
fleet scenario over real MCP/HTTP/SQLite/OTLP:

```sh
pnpm e2e:fleet
```

All required steps must be green before review is requested.

## Pick an issue

Every change is issue-bound: no issue, no change. Good starting points are
labeled `good first issue` — current candidates:

- #42 — coverage ratchet: per-file delta comment on every PR (CI YAML + a
  small script, self-contained)
- #43 — Playwright smoke test for the admin console (one spec:
  login → onboard → fleet board)

Claim one, and put a short plan on the issue before coding: one behavior,
files to touch, explicit out-of-scope, test/evidence strategy, applicable
review skills.

## PR rules (from `AGENTS.md` § Workflow)

- **Issue-bound.** Commit title and PR carry the issue number.
- **Invariant commit subject**, not a summary — a falsifiable behavior claim
  a reviewer can check ("X never happens, because Y").
- **One behavior per PR, landed daily.** One open PR at a time.
- **Branch naming:** `<kind>/<short-name>` (`feat/…`, `fix/…`, `docs/…`,
  `chore/…`). `main` moves only by PR merge.
- **Delete, don't harden:** a finding on a code path nothing calls is
  answered by deleting the path.
- **Independent review before merge.** Self-review against every applicable
  checklist in `skills/` (always `polymer-bringup-gate`), then an
  independent review (read-only subagent or human) with verdict
  `PASS` / `CONDITIONAL` / `FAIL`. The author never merges their own PR.
- **Merge:** squash, working tree clean, `main` green.

Review skills in `skills/`: `polymer-bringup-gate` (scope, win condition,
commit rhythm — always), `polymer-security-review`,
`polymer-concurrency-review`, `polymer-api-contract-review`,
`polymer-telemetry-review`.
