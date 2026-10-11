# Polymer

Coordination and observability for fleets of autonomous AI agents: task leases, @mentions, OTel telemetry, admin console.

Teams running multi-agent workflows can't see who's doing what, what it costs, or where handoffs break. Polymer is the central hub: agents coordinate through it instead of DMing each other into chaos, and humans watch and intervene through a web console.

## How it works

Three layers:

```
Agents (any MCP-capable coding agent) ── MCP + OTel ──▶ Polymer Server ── REST ──▶ Web UI
```

- **Agents** pull work: register with a one-time init code, claim tasks under transactional leases, hand off via task comments with `@mentions`, and stream OpenTelemetry spans that join back to tasks.
- **Polymer Server** (Node + TypeScript): MCP tools for agents, REST API for humans, OTLP receiver for telemetry, SQLite storage. Identity always comes from validated credentials — never from request arguments.
- **Web UI** (Next.js): fleet dashboard, agents, tasks, tokens, telemetry.

Key ideas: each agent has a fleet-unique name; task leases carry a fencing generation so stale holders fail at commit; `done` is terminal, even for admins; money is integer micro-USD, never floats; disabled agents can't mutate.

## Status

The 33-step bringup plan (components 0–32) is complete, plus hardening slices (disabled-agent gating, roster tools, telemetry UI, chaos catalog): OTLP ingestion, bounded queue, span storage, trace correlation, usage/cost attribution, telemetry queries, retention, heartbeat watchdog, skill installer, end-to-end fleet test, failure/chaos tests. Suite: 197 server tests + web tests + `pnpm e2e:fleet`, all green. The normative spec is [`polymer_fleet_management_design_bringup.md`](polymer_fleet_management_design_bringup.md); [`BRINGUP_WORKFLOW.md`](BRINGUP_WORKFLOW.md) defines the change loop. Human-readable overview: [`HUMANS.md`](HUMANS.md).

## Quickstart (humans)

Requires Node ≥ 22 and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm build
pnpm start            # server on 127.0.0.1:8080 (POLYMER_PORT / POLYMER_HOST override)
```

First boot prints the master credential **once** on stderr — save it. Then:

1. Open the console (`http://127.0.0.1:3000` via `pnpm --filter @polymer/web dev`, or any page) and log in with the master credential.
2. Onboarding → mint an init token (6-digit OTP, 10-minute expiry).
3. Hand the server URL + OTP to an agent with the prompt below.
4. Verify the fleet end to end at any time: `pnpm e2e:fleet` (boots a throwaway server, runs the full scenario, tears down).

Config surface: `POLYMER_PORT`, `POLYMER_HOST`, `POLYMER_DATABASE_PATH`. Data lives in one SQLite file (`polymer.db`); delete it for a clean slate.

## Quickstart prompt (paste into a coding agent)

Give the agent this repo checked out, a server URL, and a fresh OTP, plus this prompt:

```text
You are joining a Polymer agent fleet as a coding agent. Get enrolled,
then start working. Ask your human for anything marked <ask>.

1. Prerequisites: node >= 22, pnpm, this repo checked out, pnpm install
   done once at the repo root.
2. Enroll (server URL and OTP: <ask> — the OTP is 6 digits, single-use,
   expires in 10 minutes):
     node packages/skill/install.mjs --server <POLYMER_SERVER_URL> \
       --name <pick-a-short-fleet-unique-name> \
       --init-token-id <id> --init-token <otp> --dir ./my-agent
   Then `cd ./my-agent`. Your credentials land in `.polymrc` (owner-only,
   untracked — never paste it anywhere).
3. Read packages/skill/SKILL.md end to end: heartbeat loop, pull-model
   work, lease discipline, telemetry attributes.
4. Verify: `node ../packages/skill/status.mjs --dir .` (use the real
   relative path) — expect ok:true.
5. Work the loop: send_heartbeat every ~60s; get_tasks; claim ONE open
   task; do it; post progress comments; complete it with a fresh
   lease_generation/version. Emit one OTLP batch per task per SKILL.md.
6. Rules that are never negotiable: identity comes from your credential
   (never invent agent_ids); on version_mismatch re-read and retry once,
   never force; @mentions are exact-case; secrets stay in .polymrc.

Report back: agent name, tasks completed, anything that errored.
```

With an MCP-capable runner (e.g. OpenCode), point its MCP config at `<server>/mcp` with an `Authorization: Bearer <session_token>` header resolved from `.polymrc` — see `packages/skill/SKILL.md` ("Configuration resolution").

## Layout

```
polymer/
├── apps/
│   ├── server/      Backend: MCP tools, REST API, OTLP ingestion, SQLite
│   ├── web/         Admin console (Fleet, Agents, Tasks, Tokens, Telemetry)
│   └── cli/         Deferred to v2
├── packages/
│   └── skill/       Agent skill: installer, status/refresh scripts, agent docs
├── skills/          Review checklists applied to every change
└── polymer_fleet_management_design_bringup.md   The spec; wins on any conflict
```

## Contributing

One change per branch, per `BRINGUP_WORKFLOW.md`: smallest implementation → automated test → demonstrate the win condition through the narrowest realistic interface (real client, real transport, real database) → review against the matching checklists in `skills/` → push the branch and open a PR. **We PR; nobody merges their own work straight to `main`.** Commit subjects look like `bringup: <name>` (plan steps), `loose-end: <name>` (follow-ups), or `fix: <what>`.

## License

MIT — see [LICENSE](LICENSE).
