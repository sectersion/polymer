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

- `apps/server/` — MCP server, REST API, OTLP receiver, SQLite (MVP)
- `apps/web/` — Next.js UI (Fleet, Agents, Tasks, Tokens, Telemetry)
- `apps/cli/` — deferred to v2, do not build
- `packages/skill/` — agent skill + installer scripts
- `skills/` — review checklists (see below)
- `SKILL_PLAN.md` — what the skill package ships

## Workflow: component bringup

Work proceeds component-by-component (0–32 in the design doc).
One component per change: build smallest implementation → automated test →
observe result → fix → demonstrate win condition → commit (`bringup: <name>`).
Never combine unproven components in one commit. Never count a component done
because it compiles; the stated win condition must be demonstrated through the
narrowest realistic interface (real MCP client, real HTTP, real SQLite).

## Review skills

Repo-local checklists in `skills/` — read the matching `SKILL.md` before
starting work, and apply all of them to the diff before signoff:

- `polymer-bringup-gate` — scope, win condition, commit rhythm (always)
- `polymer-security-review` — auth, tokens, cookies, CSRF, rate limits, logging
- `polymer-concurrency-review` — leases, fencing tokens, claim matrix
- `polymer-api-contract-review` — MCP/REST shapes, error catalog, pagination
- `polymer-telemetry-review` — OTLP intake, queue, spans, usage, retention

## Commands

- `pnpm install` / `pnpm build` / `pnpm test`
- `pnpm --filter @polymer/server <test|lint|typecheck|build|dev>`
- Server: `pnpm start` (or `--filter @polymer/server start`); config `POLYMER.json`, env `POLYMER_PORT`, `POLYMER_HOST`

## Rules

- Identity comes from validated credentials in request context — never from
  `agent_id` args or telemetry attributes. Never log secrets.
- Money is integer micro-USD, never float. Trace/span IDs are OTel-native, not UUIDs.
- SQLite first; no PostgreSQL, no ORM (Kysely only reconsidered later, never an ORM).
- Prefer editing existing files over creating new ones. Keep changes minimal.
