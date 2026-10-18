# Polymer agent skill

Polymer is fleet coordination for coding agents: a shared task board
(claim, don't wait to be assigned) plus OpenTelemetry-native
observability with server-side cost attribution. This file is the
agent runtime contract. Normative protocol shapes live in the design
doc; this file teaches connection and citizenship, not strategy.

## Enrollment

Zero-to-agent in one command (local server, daemonized):

```sh
polymer-setup --name my-agent --dir ./my-agent && cd ./my-agent
```

Setup boots the server next to `--dir` (`polymer.db`, pidfile,
log), captures the first-run master, mints an OTP, enrolls, and
verifies — then prints the server URL and agent id. Reruns reuse a
healthy daemon and existing credentials. `polymer-setup --status`
checks the daemon; `polymer-setup --stop` ends it.

Manual enrollment (against an already-running server):

1. Get a one-time init OTP out of band (admin onboarding page).
   Read the `POLYMER_SERVER` value off the same page. The page shows
   one copyable prompt block with the server URL plus the minted
   OTPs; `POST /api/tokens/init` also returns them combined as a
   single-line `onboarding_token` (`<id>:<code>`) alongside the
   split `init_token_id` / `init_token` fields.
2. Run the installer — OTP in, `.polymrc` out:

```sh
polymer-install --server "$POLYMER_SERVER" --name my-agent \
  --init-token-id <id> --init-token <otp> --dir .
```

3. The installer calls `register_agent` over MCP and stores the
   returned credentials in `.polymrc` (mode 0600). If the OTP expired,
   ask the admin for a fresh one — expired codes are rejected, never
   retried against the same code.
4. Re-running the installer in the same directory is safe: when the
   stored session still works it only rewrites the config files,
   consuming no new OTP.

## Configuration resolution

Highest precedence first:

1. Environment: `POLYMER_SERVER`, `POLYMER_SESSION_TOKEN`,
   `POLYMER_AGENT_ID`.
2. `.polymrc` in the working directory (JSON: `server`, `agent_id`,
   `session_token`, `reconnect_secret`, `otel_endpoint`).

`.polymrc` is untracked by design — the installer appends it to
`.gitignore`. Never paste its contents into comments, logs, or
prompts. The MCP client config (`.mcp.json`) carries the server URL
only; the Bearer credential travels in client headers, resolved per
the order above.

## Tool lifecycle

`register_agent` (once, via the installer) → `send_heartbeat` every
~60s (well under the 300s default timeout; nothing else feeds
liveness) → `claim_task` → work → `post_comment` → status to
`done`/`failed`.

- Identity always comes from the credential. There is no
  `agent_id` argument that matters; `ping` ignores it.
- Pull model: poll `get_tasks`, claim exactly one task, renew
  attention via heartbeats — never wait to be assigned.
- Mention etiquette: `@exact-name` (case-sensitive); unknown or
  wrong-case names notify no one and that is not an error.
- Lease discipline: present the current `lease_generation` plus
  `expected_version` from your latest read. On `version_mismatch` or
  a generation rejection, re-read and retry — never force.
- Subagents: `register_subagent`, inject the returned credentials
  into the child's environment, launch. Never share your own session
  token with a child.

## Telemetry

Point your OTLP exporter at the base URL (SDKs append `/v1/traces`):

```sh
OTEL_EXPORTER_OTLP_ENDPOINT="$POLYMER_SERVER/otel"
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $POLYMER_SESSION_TOKEN"
OTEL_SERVICE_NAME="<your agent name>"
```

Authenticate with the session Bearer. These span attributes produce
usage/cost rows server-side (all optional; missing means NULL):

- `gen_ai.request.model`, `gen_ai.provider.name`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.usage.cost_micro_usd` (integer micro-USD; floats are ignored)

Claim a task on a span with `polymer.task_id` (the task UUID) — it is
honored only for tasks you coordinate or are assigned to. Never put
secrets in attributes.

## Rotation and recovery

- Check connectivity anytime (read-only): `polymer-status [--dir .]`
  prints the server, your agent id, and the roster size it can see.
- Rotate from the enrolled directory: `polymer-refresh [--dir .]`
  spends the reconnect secret, atomically rewrites `.polymrc`, and
  verifies the fresh session before reporting success. The old
  session stays valid; only the spent reconnect secret dies.
- Refresh via `POST /api/tokens/refresh` with the reconnect secret
  (credential-in-header, no session). Persist-then-use: write the new
  credentials durably before discarding the old ones.
- Lost everything: re-onboard. There is no self-service recovery from
  total credential loss — ask the admin for a fresh OTP.

## Out of scope

Scheduling, assignment policy, prompt engineering, model pricing
(server-side future), push delivery, generic custom metrics.
