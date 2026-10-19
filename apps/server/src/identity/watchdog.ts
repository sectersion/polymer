import type { PolymerDatabase } from "../database/db.js";
import type { EventBus } from "../http/events.js";
import { AgentNotFoundError, getAgentById } from "./agents.js";

/**
 * Component 29: agent liveness, and nothing else.
 *
 * Two strictly separated jobs plus the heartbeat ingress that feeds
 * job 1 (`send_heartbeat` is the ONLY writer of `last_seen`):
 *
 * - `recordHeartbeat`: authenticated heartbeat → `last_seen = now`
 *   and `idle`, keeping `working` while the agent coordinates any
 *   task under a live lease (documented implementation pick for the
 *   spec's either/or). Heartbeat on a `disabled` agent is rejected
 *   `unauthorized` with no write of any kind. Revives
 *   `disconnected` agents back into the live set.
 * - Job 1 `runLivenessSweep`: `now - last_seen > timeout` flips any
 *   live status to `disconnected`, bounded 500 per statement.
 *   `disabled` is never auto-touched (only re-onboarding clears it).
 * - Job 2 (lease notifier): emits `task.lease_expired` events only
 *   and writes nothing — ownership stays exclusively in the
 *   tool-handler transactions, so there is deliberately no
 *   reclamation step here, lazy or otherwise.
 */

export class HeartbeatUnauthorizedError extends Error {
  readonly code = "unauthorized";
  constructor(agentId: string) {
    super(`heartbeat rejected for disabled agent: ${agentId}`);
    this.name = "HeartbeatUnauthorizedError";
  }
}

/** Max status flips per sweep statement (single-writer rule). */
const LIVENESS_BATCH_ROWS = 500;
/** Max lease notifications per notifier run (bounded burst). */
const LEASE_NOTIFY_BATCH_ROWS = 500;

function hasLiveLease(
  db: PolymerDatabase,
  agentId: string,
  nowIso: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM tasks
        WHERE coordinator = ? AND lease_expires_at IS NOT NULL
          AND lease_expires_at > ? LIMIT 1`,
    )
    .get(agentId, nowIso) as { ok: number } | undefined;
  return row !== undefined;
}

export function recordHeartbeat(
  db: PolymerDatabase,
  agentId: string,
  nowMs: number = Date.now(),
): { success: true; timestamp: string } {
  const agent = getAgentById(db, agentId);
  if (agent === undefined) throw new AgentNotFoundError(agentId);
  if (agent.status === "disabled")
    throw new HeartbeatUnauthorizedError(agentId);
  const nowIso = new Date(nowMs).toISOString();
  const status = hasLiveLease(db, agentId, nowIso) ? "working" : "idle";
  const update = db.transaction(() => {
    db.prepare(
      "UPDATE agents SET last_seen = ?, status = ? WHERE agent_id = ?",
    ).run(nowIso, status, agentId);
  });
  update();
  return { success: true as const, timestamp: nowIso };
}

interface LivenessSweepResult {
  marked: string[];
  truncated: boolean;
}

/**
 * Job 1: flip stale agents to `disconnected`. Returns the marked ids
 * (published as `agent.status_changed` when a bus is given).
 */
export function runLivenessSweep(
  db: PolymerDatabase,
  events: EventBus | null,
  options: { nowMs?: number } = {},
): LivenessSweepResult {
  const nowIso = new Date(options.nowMs ?? Date.now()).toISOString();
  const mark = db.transaction(() => {
    const rows = db
      .prepare(
        `UPDATE agents SET status = 'disconnected'
          WHERE rowid IN (
            SELECT rowid FROM agents
             WHERE status NOT IN ('disabled', 'disconnected')
               AND (strftime('%s', ?) - strftime('%s', last_seen))
                     > heartbeat_timeout_seconds
             LIMIT ?
          )
          RETURNING agent_id`,
      )
      .all(nowIso, LIVENESS_BATCH_ROWS) as Array<{ agent_id: string }>;
    return rows.map((r) => r.agent_id);
  });
  const marked = mark();
  if (events !== null) {
    for (const agentId of marked) {
      events.publish("agent.status_changed", {
        agent_id: agentId,
        status: "disconnected",
      });
    }
  }
  let truncated = false;
  if (marked.length === LIVENESS_BATCH_ROWS) {
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM agents
          WHERE status NOT IN ('disabled', 'disconnected')
            AND (strftime('%s', ?) - strftime('%s', last_seen))
                  > heartbeat_timeout_seconds`,
      )
      .get(nowIso) as { n: number };
    truncated = remaining.n > 0;
  }
  return { marked, truncated };
}

interface ExpiredLease {
  task_id: string;
  coordinator: string;
  lease_generation: number;
  lease_expires_at: string;
}

/**
 * Job 2: lease-expiry notifier. Emits `task.lease_expired` per newly
 * expired lease and writes nothing — callers can prove that by
 * snapshotting tables across a run.
 *
 * Dedup is an exact notified-set, reconciled against the current
 * expired list every run (a time watermark would permanently miss an
 * expiry backdated below it, e.g. an admin forcing a lease into the
 * past). Consequences, all deliberate:
 * - Renewed tasks leave the expired list, so a later re-expiry
 *   notifies again; deleted tasks drop out silently.
 * - Un-notified expiries are excluded in SQL, so a deep backlog
 *   drains oldest-first across runs instead of starving behind the
 *   per-run cap.
 * - The set is capped (dup burst past it, never a miss, never
 *   unbounded memory).
 */
export function createLeaseNotifier(
  events: EventBus,
  maxTracked = 5000,
): {
  check(db: PolymerDatabase, nowMs?: number): ExpiredLease[];
} {
  let notified = new Set<string>();
  return {
    check(db: PolymerDatabase, nowMs: number = Date.now()): ExpiredLease[] {
      const nowIso = new Date(nowMs).toISOString();
      if (notified.size > maxTracked) notified.clear();
      const exclusion =
        notified.size === 0
          ? ""
          : `AND task_id NOT IN (${[...notified].map(() => "?").join(",")})`;
      const rows = db
        .prepare(
          `SELECT task_id, coordinator, lease_generation, lease_expires_at
             FROM tasks
            WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ?
            ${exclusion}
            ORDER BY lease_expires_at ASC, rowid ASC
            LIMIT ?`,
        )
        .all(nowIso, ...notified, LEASE_NOTIFY_BATCH_ROWS) as Array<
        Record<string, unknown>
      >;
      const expiredIds = db
        .prepare(
          `SELECT task_id FROM tasks
            WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .all(nowIso) as Array<{ task_id: string }>;
      // Reconcile: drop ids that left the expired list (renewed or
      // deleted tasks re-notify on their next expiry), then track
      // exactly what this run emitted — never un-emitted rows past
      // the per-run cap, or a deep backlog would starve behind them.
      const current = new Set(expiredIds.map((r) => r.task_id));
      notified = new Set([...notified].filter((id) => current.has(id)));
      const expired: ExpiredLease[] = rows.map((row) => ({
        task_id: row["task_id"] as string,
        coordinator: row["coordinator"] as string,
        lease_generation: row["lease_generation"] as number,
        lease_expires_at: row["lease_expires_at"] as string,
      }));
      for (const lease of expired) {
        notified.add(lease.task_id);
        events.publish("task.lease_expired", {
          task_id: lease.task_id,
          coordinator: lease.coordinator,
          lease_generation: lease.lease_generation,
          lease_expires_at: lease.lease_expires_at,
        });
      }
      return expired;
    },
  };
}
