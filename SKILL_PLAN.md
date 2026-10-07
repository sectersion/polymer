# SKILL_PLAN.md — Polymer skill + agent scripts

> Planned contents of `packages/skill` and the responsibilities of the
> agent side. Written ahead of component 30; the component builds this.
> Normative tool/route shapes live in the design doc — this file lists
> what ships and what the agent must do.

## What the skill package ships

-   `SKILL.md`: what Polymer is, the pull-model (claim, don't wait to
    be assigned), the tool lifecycle (register → heartbeat → claim →
    comment → complete), mention etiquette (`@exact-name`), and the
    rule that identity always comes from the credential.
-   Installer script (idempotent, rerunnable): writes MCP client config
    pointing at `POLYMER_SERVER`, creates `.polymrc` from supplied
    credentials, appends `.polymrc` to `.gitignore`, never writes
    secrets to tracked files.
-   MCP config template: server URL, transport (Streamable HTTP),
    credential env resolution order (env > `.polymrc`).
-   OTel exporter setup: `OTEL_EXPORTER_OTLP_ENDPOINT` (base URL; SDK
    appends `/v1/traces`), `OTEL_EXPORTER_OTLP_HEADERS` with the
    session Bearer, `OTEL_SERVICE_NAME` = agent name. Documents which
    `gen_ai.*` span attributes produce usage/cost rows.
-   Enrollment guide: where the OTP comes from (admin onboarding page),
    `register_agent` call shape, storing returned credentials, what to
    do when the OTP expires (ask admin for a fresh one).
-   Rotation guide: when/how to call refresh, persist-then-use ordering
    (write new credentials durably before discarding old), recovery =
    re-onboarding on loss.

## Agent-side responsibilities (runtime contract)

1.  **Heartbeat loop**: call `send_heartbeat` every ~60s (well under
    the 300s default timeout). Nothing else feeds liveness.
2.  **Credential hygiene**: `.polymrc` untracked, never pasted into
    comments/logs/prompts; reconnect secret used only for refresh.
3.  **Lease discipline**: present current `lease_generation` +
    `expected_version` from the latest read; on `version_mismatch` or
    generation rejection, re-read and retry, never force.
4.  **Subagent spawning**: `register_subagent`, inject returned
    credentials into the child's env, launch. Never share your own
    session token with a child.
5.  **Telemetry**: emit spans with `gen_ai.*` usage attributes when
    available so cost attribution works; never put secrets in
    attributes (they may be logged as counts only on failure).

## Scripts / helpers (planned)

-   `polymer-install`: interactive + non-interactive enrollment
    (server URL, OTP in, `.polymrc` out).
-   `polymer-status`: authenticated `ping` + roster peek (connectivity
    check for debugging, read-only).
-   `polymer-refresh`: rotate credentials safely (atomic file replace).
-   Heartbeat: documented loop snippet per host type (shell background
    loop; supervisor/systemd unit example in docs, not code).

## Out of scope for the skill

Scheduling, task assignment policy, prompt engineering for agents,
model pricing tables (server-side future), push delivery. The skill
teaches connection and citizenship, not strategy.

## Acceptance (feeds component 30 + 31)

Installer runs clean in a temp repo, twice idempotent; E2E
(`pnpm e2e:fleet`) configures every test agent through the installer,
not hand-rolled env.
