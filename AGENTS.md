<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Polymer

Fleet management + observability for autonomous multi-agent workflows.
Three layers: agents (MCP + OTel) → Polymer server (Node/TS) → web UI (Next.js).
Normative spec: `polymer_fleet_management_design_bringup.md`. Design doc wins on any conflict.

## Layout

- `apps/server/` — MCP server, REST API, OTLP receiver, SQLite. MVP complete (components 0–32).
- `apps/web/` — Next.js UI (Fleet, Agents, Tasks, Tokens, Telemetry)
- `apps/cli/` — deferred to v2, do not build
- `packages/skill/` — agent skill + installer scripts (`polymer-install`, `polymer-setup`, `polymer-status`, `polymer-refresh`, `polymer-proxy`)
- `skills/` — review checklists (see below)
- `docs/` — design-doc companions: bringup workflow, skill plan, human overview, index

## Working agreement (how every change lands — issue #34)

1. Every change is **issue-bound**: commit title and PR carry the issue number. No issue, no change.
2. **Commit subjects are invariants**, not summaries — a falsifiable behavior claim the reviewer can check (_"X never happens, because Y"_).
3. **One behavior per PR, landed daily.** Cap work-in-progress at one open PR.
4. **Delete, don't harden**: a finding on a code path nothing calls is answered by deleting the path.
5. **Independent review before merge**: a review subagent (read-only) returns `PASS`/`CONDITIONAL`/`FAIL`; the author never merges their own PR.

## Workflow (idea → PR — follow in order, no skipping)

0. **Idea → issue.** Every change has an issue before a branch exists.
   Label at creation: `bug` | `enhancement` | `documentation`
   (+ `good first issue` / `contributor request` where applicable).
   A vague one-liner gets a plan comment on the issue before work starts.
   Cezar is wired up on this repo: adding the `needs-agent` label to an
   issue hands it to Cezar, which tackles it through this same workflow
   (plan, branch, PR, review). At most one `needs-agent` issue is in
   flight at a time — the next one gets the label only after the
   previous PR is merged or the label comes off. (#82)
1. **Plan on the issue.** One behavior, files to touch, explicit
   out-of-scope, test/evidence strategy, applicable review skills.
   Lock decisions before coding.
2. **Branch `<kind>/<short-name>`** (`feat/…`, `fix/…`, `docs/…`,
   `chore/…`). `main` moves only by PR merge. One open PR at a time.
3. **Implement.** One behavior per PR. Apply the working agreement above
   (issue-bound, invariant subject, delete-don't-harden).
4. **Verify (local, in order — mirrors CI).** `pnpm build` → `pnpm lint` →
   `pnpm typecheck` → `pnpm format:check` → scoped `test` → full `test`.
   Run `pnpm e2e:fleet` when the diff touches server routes, MCP, or
   telemetry. All required steps green before review is requested.
5. **Review.** Self-review the diff against every applicable skill in
   `skills/` (always `polymer-bringup-gate`); then independent review
   (read-only subagent or human) with verdict `PASS` / `CONDITIONAL` /
   `FAIL`. The author never merges their own PR.
6. **Merge.** Squash, working tree clean, `main` green. Close the issue,
   move to the next one.

CI mapping (`ci.yml`): step 4's build/lint/typecheck/format run in the
`quality` job; tests run as `tests (server+web × node)`; the conditional
e2e runs in the `e2e (fleet)` job; image breakage fails the `docker` job.
`docs/BRINGUP_WORKFLOW.md` is the superseded bringup-component loop —
kept for history, not the current path.

## Review skills

Repo-local checklists in `skills/` — read the matching `SKILL.md` before
starting work, and apply all of them to the diff before signoff:

- `polymer-bringup-gate` — scope, win condition, commit rhythm (always)
- `polymer-security-review` — auth, tokens, cookies, CSRF, rate limits, logging
- `polymer-concurrency-review` — leases, fencing tokens, claim matrix
- `polymer-api-contract-review` — MCP/REST shapes, error catalog, pagination
- `polymer-telemetry-review` — OTLP intake, queue, spans, usage, retention

## Commands

- `pnpm install` / `pnpm build` / `pnpm test` / `pnpm lint` / `pnpm typecheck` / `pnpm format:check`
- `pnpm --filter @polymer/server <test|lint|typecheck|build|dev>`; same for `@polymer/web` and `@polymer/skill`
- `pnpm e2e:fleet` — full fleet scenario over real MCP/HTTP/SQLite/OTLP; the proof step for any claim
- `pnpm demo` — built stack with seeded fleet (`scripts/demo.mjs`)
- Server: `pnpm start`; config `POLYMER.json`, env `POLYMER_PORT`, `POLYMER_HOST`
- CI (`.github/workflows/ci.yml`): parallel matrix — quality (build/lint/typecheck/format), tests (server+web × node 22/24, server coverage report-only), e2e, docker

## Rules

- Identity comes from validated credentials in request context — never from
  `agent_id` args or telemetry attributes. Never log secrets.
- Money is integer micro-USD, never float. Trace/span IDs are OTel-native, not UUIDs.
- SQLite first; no PostgreSQL (Phase-1 seam only, issue #21), no ORM (Kysely only
  reconsidered later, never an ORM).
- Gate a step on a command's exit code only under `set -o pipefail` — a piped
  `tail`/`grep` otherwise swallows failures (lesson from audit #29).
- Prefer editing existing files over creating new ones. Keep changes minimal.
