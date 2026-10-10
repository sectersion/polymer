import type { PolymerDatabase } from "../database/db.js";
import { recordAudit } from "./audit.js";
import { AgentNotFoundError } from "./agents.js";

export const DISABLE_BATCH_SIZE = 500;

export interface DisableResult {
  success: true;
  disabled_count: number;
  complete: boolean;
}

/**
 * Component 19: idempotent disable over a frozen subtree. The
 * descendant set is snapshotted first (recursive CTE over
 * parent_agent_id), then walked in bounded batches of 500 agents per
 * transaction, each batch with one `agent.disable.batch` audit row
 * carrying the batch's disabled_agents. Completed batches are
 * skipped (status check), so crash or 503 between batches is safe:
 * retry the same call until `complete: true`.
 *
 * Disabling releases task leases: every task the batch coordinates
 * keeps its coordinator (history) but gets `lease_expires_at: null`
 * with an incremented generation — immediately claimable.
 */
export function disableAgentSubtree(
  db: PolymerDatabase,
  agentId: string,
  actorSessionId: string,
): DisableResult {
  const root = db
    .prepare("SELECT agent_id FROM agents WHERE agent_id = ?")
    .get(agentId) as { agent_id: string } | undefined;
  if (root === undefined) {
    throw new AgentNotFoundError(agentId);
  }
  const subtree = db
    .prepare(
      `WITH RECURSIVE lineage(agent_id) AS (
         SELECT ? AS agent_id
         UNION
         SELECT agents.agent_id FROM agents
         JOIN lineage ON agents.parent_agent_id = lineage.agent_id
       )
       SELECT agent_id FROM lineage`,
    )
    .all(agentId) as Array<{ agent_id: string }>;
  const ids = subtree.map((r) => r.agent_id);

  let disabledCount = 0;
  for (let i = 0; i < ids.length; i += DISABLE_BATCH_SIZE) {
    const batch = ids.slice(i, i + DISABLE_BATCH_SIZE);
    const placeholders = batch.map(() => "?").join(",");
    const write = db.transaction(() => {
      const disabled = db
        .prepare(
          `UPDATE agents SET status = 'disabled'
            WHERE agent_id IN (${placeholders}) AND status != 'disabled'`,
        )
        .run(...batch);
      // Lease release for the batch: coordinator kept for history,
      // lease nulled, generation bumped — claimable immediately.
      db.prepare(
        `UPDATE tasks SET lease_expires_at = NULL,
            lease_generation = lease_generation + 1,
            updated_at = ?
          WHERE coordinator IN (${placeholders})
            AND lease_expires_at IS NOT NULL`,
      ).run(new Date().toISOString(), ...batch);
      recordAudit(db, {
        actor_type: "admin_session",
        actor_id: actorSessionId,
        action: "agent.disable.batch",
        before: null,
        after: {
          disabled_count: disabled.changes,
          disabled_agents: batch,
        },
      });
      return disabled.changes;
    });
    disabledCount += Number(write.immediate());
  }
  return { success: true, disabled_count: disabledCount, complete: true };
}
