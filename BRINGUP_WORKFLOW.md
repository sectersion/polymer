# Bringup Workflow

Reproducible loop for building Polymer component-by-component.
Invoke with: "Run BRINGUP_WORKFLOW.md for component N."
One component per pass, one commit per component (`bringup: <name>`).

Spec: `polymer_fleet_management_design_bringup.md` (design doc wins on conflict).
Checklists: `skills/polymer-bringup-gate/SKILL.md` (always) + whichever of
`polymer-security-review`, `polymer-concurrency-review`,
`polymer-api-contract-review`, `polymer-telemetry-review` the component touches.

## Phase 1 — Instruct (plan, no code changes)

1. Read the `## N.` section of the design doc: Build / Test / Win condition.
2. Read `skills/polymer-bringup-gate/SKILL.md` and applicable review skills.
3. Read the current code the component will touch.
4. Present a plan: driver/dependency choices, exact files to add/change,
   what is explicitly out of scope, test strategy, win-condition demo.
5. Lock user decisions (libraries, test fixtures, CLI surface). Do not
   implement until decisions are recorded.

## Phase 2 — Implement

1. Smallest implementation that satisfies the component spec — nothing more.
2. Respect route ownership (see bringup-gate skill §2). No later-component
   routes except through a stated service-layer seam.
3. No new test seams except where the plan names them. Probe tools never
   ship in production builds.
4. Follow repo rules: identity from validated credentials, integer
   micro-USD, OTel-native IDs, SQLite + raw SQL, minimal diffs.

## Phase 3 — Test (evidence, not compilation)

1. New automated tests for the component (`apps/server/src/*.test.ts`,
   run via `pnpm --filter @polymer/server test`).
2. Demonstrate the win condition through the narrowest realistic
   interface (real MCP client, real HTTP, real SQLite file — never
   handler units alone where the spec demands otherwise).
3. Regression: full prior suite still passes.
4. Hygiene: `build`, `typecheck`, `lint` clean; changed files
   `prettier`-clean (leave pre-existing violations untouched).

## Phase 4 — Review (two pairs of eyes)

1. Self-review the diff against every applicable skill; state each
   finding and its resolution.
2. Independent review: launch a subagent with a read-only mandate
   (`git status` / `git diff` / file reads only, no modifications) and
   the component spec + skills. Required verdict format:
   `PASS` / `CONDITIONAL` / `FAIL` + component number + which
   win-condition steps were observed vs. asserted.
3. Fix findings, re-run Phase 3. Repeat until PASS.

## Phase 5 — Commit

1. `git add` only the component's files. Working tree otherwise clean.
2. Message: `bringup: <component-name>` + short body recording the
   demonstrated win condition.
3. Never combine unproven components in one commit. A component is done
   only when its win condition was observed, not when it compiles.
