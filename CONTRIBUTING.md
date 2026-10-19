# Contributing to Polymer

One path from clone to merged PR. The normative loop lives in
`AGENTS.md` § Workflow (idea → PR); this file is its newcomer trailhead.

## 1. Quickstart

Requirements: Node ≥ 22, `pnpm`.

```sh
pnpm install && pnpm build
```

Run the seeded demo to see a live fleet:

```sh
pnpm demo
```

Or enroll an agent manually:

```sh
node packages/skill/setup.mjs --name you --dir ./my-fleet
```

## 2. Verify your setup

Before touching code, prove the stack is green:

```sh
pnpm e2e:fleet
```

This runs the full fleet scenario over real MCP/HTTP/SQLite/OTLP. If it
fails on a fresh clone, file a `bug` issue — do not work around it.

When you change code, verify in this order (mirrors CI):

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm format:check
pnpm --filter @polymer/<package> test   # scoped first
pnpm test                                # then full suite
```

Run `pnpm e2e:fleet` when your diff touches server routes, MCP, or
telemetry.

## 3. Pick an issue

Every change starts from an issue — no issue, no PR. Good starting
points carry the `good first issue` label (e.g. #42, #43). Comment on
the issue before starting so two people don't build the same thing.

## 4. PR rules

- Branch `<kind>/<short-name>` (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
  `main` moves only by PR merge.
- One behavior per PR. Commit subjects are invariants, not summaries —
  a falsifiable claim the reviewer can check
  (_"X never happens, because Y"_), with the issue number
  (`… (#71)`).
- Self-review against the applicable checklists in `skills/` (always
  `polymer-bringup-gate`), then request independent review: a
  `PASS` / `CONDITIONAL` / `FAIL` verdict is required, and the author
  never merges their own PR.
- Keep diffs minimal; prefer editing existing files over creating new
  ones. Never log secrets; money is integer micro-USD, never float.

## 5. Getting help

Design questions: the spec in
`polymer_fleet_management_design_bringup.md` wins on any conflict.
Process questions: ask on your issue — vague ideas get a plan comment
before work starts, and that's normal here.
