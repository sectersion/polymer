# Polymer Skills

Code-review skills derived from `polymer_fleet_management_design_bringup.md` (normative) and `SKILL_PLAN.md`.
Each skill is a review gate — use them on every diff before signoff.

- `polymer-bringup-gate/` — component scope, win condition, commit rhythm
- `polymer-api-contract-review/` — MCP/REST shapes, error catalog, pagination
- `polymer-concurrency-review/` — leases, fencing, claim matrix, watchdog separation
- `polymer-security-review/` — credentials, auth, CSRF, rate limits, logging rules
- `polymer-telemetry-review/` — OTLP intake, queue, spans, usage, retention

Normative spec always wins over these checklists. If a checklist and the design doc disagree, the design doc governs.
