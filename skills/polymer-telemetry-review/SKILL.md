---
name: polymer-telemetry-review
description: Review OTLP ingestion, bounded queue, span/usage storage, queries, and retention. Use on any diff touching telemetry, costs, or retention.
---

# Polymer Telemetry Review

Source: design doc → Usage Derivation, Aggregation, Telemetry Storage/Retention, OTLP Ingestion, config table.

## Ingestion (`POST <telemetry.endpoint>/v1/traces`, default base `/otel`)

- Auth: agent session Bearer only (identity = authenticated credential, never resource attributes). No query/coordination capability on this path.
- Validate content-type (`application/x-protobuf` preferred, `application/json`), shape, `max_request_bytes` (default 10MiB), `max_spans_per_batch` (= `batch_max_spans` default 500), per-agent quotas.
- Responses: `200` = validated + enqueued (NOT committed); `400` malformed; `401` bad credential; `413` over limits; `429` queue-full + `retry_after`; `503` DB unavailable. OTLP clients append `/v1/traces` to base URL.

## Queue + writer

- Bounded in-memory queue (`queue_max_batches` default 100) → batcher (`batch_flush_ms` default 1000) → SQLite writer. Full → `429` + `retry_after`, never unbounded growth. No txn > 500 rows; `busy_timeout: 5000`, WAL + FK on; backoff + retry on `SQLITE_BUSY`. Telemetry batches must not starve coordination (bounded size/duration).
- Durability contract: at-most-once across crashes. Crash test must prove queued-but-uncommitted loss (enqueue, kill before flush, absence after restart). Never imply durability in responses/docs. Durable spool only if real deployments demand it.

## Spans (`OTelSpan`)

Preserve native OTel semantics: `trace_id` 32 lowercase hex, `span_id`/`parent_span_id` 16 lowercase hex (NOT UUIDs), ns timestamps, kind/status, JSON attributes/resource/instrumentation-scope. Promote only filtered/joined columns (`agent_id` from auth identity, `task_id`, `trace_id`). Indexes: `trace`, `(agent_id, start)`, `start` — no speculative indexes. Span events/links tables only when needed.

## Usage (`UsageRecord`)

- Derived server-side from span attributes in the same batch txn — no separate ingestion path, no `report_usage` tool.
- Mapping (all optional, missing → NULL never error): `gen_ai.request.model → model`, `gen_ai.provider.name → provider`, `gen_ai.usage.input_tokens → input_tokens`, `gen_ai.usage.output_tokens → output_tokens`, `gen_ai.usage.cost_micro_usd → reported_cost_micro_usd`.
- `agent_id`/`trace_id` from auth + span. `task_id` accepted ONLY if agent is assigned/coordinator else NULL + `telemetry.task_id_rejected` counter (telemetry never claims work). `cost_source`: `reported` if cost attr present else `unknown` (`estimated` never emitted in MVP). One row per span with ≥1 mapped attr.
- Money: integer micro-USD everywhere, never float. Aggregation (NULL = 0): `tokens_used = SUM(in)+SUM(out)`, `cost = SUM(reported_cost_micro_usd)` (unknown rows contribute 0). SQLite 63-bit holds the 31-day max range.
- Queries: `summary` (`total_comments = COUNT(comments)`, totals), `agents` (per-agent comments/tasks/tokens/cost), `timeline?from=&to=&agent_id=` (ISO-8601 UTC, from-inclusive/to-exclusive, default last 24h, max 31d, opaque cursor), `costs?granularity=hourly|daily` (UTC-aligned, zero-filled gaps, max 31d). No generic metrics store; no `emit_custom_metric`.

## Retention + config

Independent policies: telemetry `retention_days` default 7 via bounded incremental deletes; coordination retained indefinitely. Never delete coordination in the telemetry job; prove it in tests. Config units: durations seconds (except `batch_flush_ms`), sizes bytes; `agentRolesAllowlist: null` = open.

## What to flag

Trusting telemetry `agent_id`/`task_id`, float money, `estimated` costs, unbounded queue/txn, `200`-means-committed claims, coordination starvation, telemetry failure failing coordination ops, secret/user data in logs (counts + reason only).
