# AUTOMATION.md — what automation is live today

> One page, read as of **2026-10-25**. Every line cites the issue number
> or workflow that installs it. The point of #96 M1: the
> `gh issue list --label needs-agent` queue is the filesystem-of-record
> for work; this page is the record of what those agents can already
> rely on running by itself. If a claim here is wrong, that is a bug —
> open an issue against this file.

## Work intake (how changes enter)

- **Working agreement** (`AGENTS.md`): every change is issue-bound,
  committed under an invariant subject, one behavior per PR, independent
  review before merge, author never merges their own.
- **Cezar** (#82): adding `needs-agent` hands an issue to the resident
  agent, which works it through the same loop (plan, branch, PR,
  review). At most one `needs-agent` issue in flight at a time —
  single-flight by design (#82) until #96 M3 widens it with observed
  (not theorized) race evidence.
- **Issue templates** (#119): blank issues are impossible; `bug.yml`,
  `proposal.yml` pre-fill the plan shape the workflow's step 1 needs.
- **Review routing / label hygiene** (#120): review skills
  (`skills/`) are mapped to diff types before review is requested.
- **Dependabot** (#91): `npm` and `github-actions`, weekly Monday
  06:00 UTC; minors/patches grouped into one PR each with the
  `dependencies` label; majors stay individual PRs needing real review
  (#32). No auto-merge anywhere.

## Per-PR gates (`ci.yml`)

- **quality**: `pnpm build`, `lint`, `typecheck`, `format:check` —
  mirrors workflow step 4.
- **tests**: package × Node matrix (server 22/24, web 22); server
  coverage on the primary run.
- **e2e (fleet)**: full fleet scenario over real MCP/HTTP/SQLite/OTLP.
- **e2e (web smoke)**: Playwright chromium against the admin console
  (#43).
- **docker**: both Dockerfiles built (never pushed) so image breakage
  fails the PR.
- **Coverage delta comment** (#42, #117): each PR gets a sticky
  per-file coverage-delta comment against the last green `main` run;
  visibility only, never gates.

## Publishing (`release.yml`)

- **Images**: every merge to `main` publishes
  `polymer-server` / `polymer-web` to GHCR as `:latest` + `:sha`;
  a `v*` tag additionally publishes `:<version>`.
- **Release notes** (#87): tagging `vX.Y.Z` cuts a GitHub Release with
  notes grouped by subject prefix (feat → Added, fix/audit → Fixed),
  built from squash subjects only — nothing committed back to `main`.
- **Deploy** (#76): a deploy job SSHes to the fleet host and runs
  `docker compose pull`, then `docker compose up -d --remove-orphans`,
  health-gated on the server answering `/health` (#80), with
  `DEPLOY_SSH_HOST_KEY` (#81). **Status: code live, run silent** — it
  self-skips until the `DEPLOY_*` secrets exist. Not yet proven live;
  that proof is the remaining part of #76.
- **Web health-gate** (#86): the deploy currently gates only the server
  (:8080), not the web app (:3000) — open.

## Nightly (`nightly.yml`, #110)

- 04:00 UTC daily: if commits landed since the last tag, dated
  `nightly-*` images (`nightly`, `nightly-YYYYMMDD`, `:sha`) are pushed
  and a dated prerelease is cut with real digests, compare range, and
  the merged-subject list (#115). No merges → an explicit green skip,
  never an empty release.

## Not automated yet

- The deploy's live proof (#76 — needs host + `DEPLOY_*` secrets).
- Web (:3000) in the deploy health-gate (#86).
- Post-publish smoke against the released GHCR images (#37).
- Blue-green/rollback (#76 out-of-scope; becomes mandatory before the
  fleet deploys itself on `main` without human eyes — #96 rule 3).
- Parallel agent PRs (#96 M3; fan-out caps design in #44).
- Release → deploy → observe closed loop (#46, #47), with backup (#94)
  and TLS proxy (#93) ahead of it.
