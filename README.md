# Polymer

Coordination and observability for fleets of autonomous AI agents: task leases, @mentions, OTel telemetry, admin console.

Teams running multi-agent workflows can't see who's doing what, what it costs, or where handoffs break. Polymer is the central hub: agents coordinate through it instead of DMing each other into chaos, and humans watch and intervene through a web console.

## How it works

Three layers:

```
Agents (Claude Code, OpenSWE, …) ── MCP + OTel ──▶ Polymer Server ── REST ──▶ Web UI
```

- **Agents** pull work: register with a one-time init code, claim tasks under transactional leases, hand off via task comments with `@mentions`, and stream OpenTelemetry spans that join back to tasks.
- **Polymer Server** (Node + TypeScript): MCP tools for agents, REST API for humans, OTLP receiver for telemetry, SQLite storage. Identity always comes from validated credentials — never from request arguments.
- **Web UI** (Next.js): fleet dashboard, agents, tasks, tokens, telemetry.

Key ideas: each agent ("monomer") has a fleet-unique name; task leases carry a fencing generation so stale holders fail at commit; `done` is terminal, even for admins; money is integer micro-USD, never floats.

## Status

Under construction, component by component — components 0–9 of 32 have landed so far: runtime skeleton, health, MCP transport, auth middleware, SQLite, agent table, credential storage, registration, session auth, credential rotation. The normative spec is [`polymer_fleet_management_design_bringup.md`](polymer_fleet_management_design_bringup.md); [`BRINGUP_WORKFLOW.md`](BRINGUP_WORKFLOW.md) defines the one-component-per-commit loop. Human-readable overview: [`HUMANS.md`](HUMANS.md).

## Quickstart

Requires Node ≥ 22 and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
pnpm test
pnpm start            # server on 127.0.0.1:8080 (POLYMER_PORT / POLYMER_HOST override)
```

## Layout

```
polymer/
├── apps/
│   ├── server/      Backend: MCP tools, REST API, OTLP ingestion, SQLite
│   ├── web/         Admin console (Fleet, Agents, Tasks, Tokens, Telemetry)
│   └── cli/         Deferred to v2
├── packages/
│   └── skill/       Agent skill: teaches an agent environment to join the fleet
├── skills/          Review checklists applied to every change
└── polymer_fleet_management_design_bringup.md   The spec; wins on any conflict
```

## Contributing

One component per change, per `BRINGUP_WORKFLOW.md`: smallest implementation → automated test → demonstrate the win condition through the narrowest realistic interface (real client, real transport, real database) → review against the matching checklists in `skills/` → commit as `bringup: <name>`.

## License

MIT — see [LICENSE](LICENSE).
