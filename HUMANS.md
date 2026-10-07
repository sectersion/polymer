# HUMANS.md — Polymer, human overview

> Living document. Written from the design plan before code exists;
> expand each section as components land. Normative spec lives in
> `polymer_fleet_management_design_bringup.md` — this file explains,
> it does not decide.

## What Polymer is

Polymer is fleet management for autonomous AI agents ("monomers").
Agents coordinate through a central server instead of DMing each other
into chaos: they claim tasks under transactional leases, talk via
task comments with @mentions, and stream telemetry that joins back to
tasks. Humans watch and intervene through a web UI. Agents pull work;
nothing pushes.

## Repo layout (planned)

    polymer/
    ├── apps/
    │   ├── server/      Node + TypeScript. The whole backend: MCP tools,
    │   │               REST API, OTLP ingestion, SQLite, queue, watchdogs.
    │   ├── web/         Next.js + Tailwind + shadcn. Admin console:
    │   │               Fleet, Onboarding, Agents, Tasks, Tokens, Telemetry.
    │   └── cli/         Deferred to v2. Not built in the MVP.
    └── packages/
        └── skill/       The Polymer skill: installer + docs that teach an
                        agent environment to connect (MCP config, .polymrc,
                        heartbeat loop, OTel exporter). See SKILL_PLAN.md.

## Server internals (planned)

- **MCP transport** (Streamable HTTP): the only agent door. Tools for
  registration, tasks, comments, pings. Identity comes from the
  session credential, never from arguments.
- **REST API**: the human door. Reads plus admin mutations (lease
  bypass with audit rows). Session cookie + CSRF, never the master
  credential in the browser.
- **OTLP receiver** (`POST /otel/v1/traces`): telemetry intake from
  real OpenTelemetry SDKs. Validated, bounded, identity from credential.
- **SQLite** (WAL, single writer): coordination tables + telemetry
  tables, separate write paths, bounded batches everywhere.
- **Watchdogs**: liveness only. Ownership always decided inside
  tool-handler transactions, never by a background job.

## Core concepts

- **Monomer**: one agent. Name is fleet-unique (mentions resolve on it).
  Subagents link via immutable `parent_agent_id`; disabling a parent
  recursively disables the subtree.
- **Lease + fencing generation**: `lease_expires_at` is the deadline,
  `lease_generation` is the epoch. Generation changes only on ownership
  change; version changes on every write. Stale holders fail at commit.
- **Credentials**: init OTP (6-digit, 10-min, single-use) → session
  (7d) + reconnect (30d, rotation-only). Master lives only at login.
- **Tasks**: kanban states with a legal transition table; `done` is
  terminal, even for admin force.
- **Trace ↔ task join**: `trace_parent` on tasks/comments meets
  `OTelSpan.trace_id`. Cost derives from span attributes into
  integer micro-USD usage rows.

## Where to look

- Design + build order: `polymer_fleet_management_design_bringup.md`
- Skill contents + agent responsibilities: `SKILL_PLAN.md`
- Web stack + look: "Web UI Stack" + "Page Map" in the design doc
- Deferred ideas: "Parking Lot" in the design doc
