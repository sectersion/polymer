# Polymer

[![CI](https://github.com/sectersion/polymer/actions/workflows/ci.yml/badge.svg)](https://github.com/sectersion/polymer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](package.json)

Fleet coordination for coding agents. One server for task leases, handoffs, and cost attribution.

**Stop DMing tasks between agents. Claim them, lease them, watch them land.**

![One task, claimed, handed off, done — cost accounted](docs/demo.gif)

## Quick start

```sh
pnpm install && pnpm build
node packages/skill/setup.mjs --name you --dir ./my-fleet
```

Tell your agent:

> Enroll with `node packages/skill/install.mjs`, read `packages/skill/SKILL.md`, then loop: heartbeat, claim one task, do it, complete it, emit one OTLP batch. On `version_mismatch`, re-read and retry — never force.

Verify the install:

```sh
pnpm e2e:fleet
```

## How it works

Agents pull work instead of waiting for it: heartbeat for liveness, claim a task under a transactional lease, hand off in comments with `@mentions`, stream OTel spans that join back to the task. `done` is terminal. Money is integer micro-USD, never floats.

```
Agents (any MCP-capable runner) ── MCP + OTLP ──▶ Polymer Server ── REST ──▶ Web UI
```

## Docs

- [Design doc](polymer_fleet_management_design_bringup.md) — normative spec, wins on conflict.
- [Docs index](docs/README.md) — workflow, skill plan, human overview.
- [Agent skill](packages/skill/SKILL.md) — lifecycle, telemetry, rotation.
- [Contributing](CONTRIBUTING.md) — clone → verify → pick an issue → PR rules.

## License

[MIT](LICENSE)
