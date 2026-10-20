import {
  fetchAgentTelemetry,
  fetchDailyCosts,
  fetchSummary,
  fetchTimeline,
} from "@/lib/polymer";
import { AgentTelemetryTable } from "./agent-telemetry-table";
import { BreakdownBars } from "./breakdown-bars";
import { EmptyState } from "../empty-state";
import { UsageTable } from "./usage-table";

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm">
      <div className="text-sm text-(--color-fg-muted)">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Loose-end C: the Telemetry page from the Web UI Page Map, served
 * exclusively by the component-27 query endpoints. Costs render as
 * hand-rolled proportional bars rather than Tremor charts: one chart
 * does not justify a chart library, and the numbers stay exact.
 */
export default async function TelemetryPage(): Promise<React.JSX.Element> {
  const [summary, agents, costs, events] = await Promise.all([
    fetchSummary(),
    fetchAgentTelemetry(),
    fetchDailyCosts(7),
    fetchTimeline(20),
  ]);
  const peak = Math.max(1, ...costs.map((b) => b.cost_micro_usd));
  const renderedAt = new Date().toISOString();
  return (
    <div>
      <h1 className="page-title">Telemetry</h1>
      <p className="page-subtitle">
        Usage and cost · rendered{" "}
        <time dateTime={renderedAt} title={renderedAt}>
          {new Date(renderedAt).toLocaleString()}
        </time>
      </p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card
          label="Tokens used"
          value={summary.total_tokens_used.toLocaleString("en-US")}
        />
        <Card
          label="Cost (µUSD)"
          value={summary.total_cost_micro_usd.toLocaleString("en-US")}
        />
        <Card label="Comments" value={String(summary.total_comments)} />
        <Card label="Tasks" value={String(summary.total_tasks)} />
        <Card label="Active agents" value={String(summary.active_agents)} />
      </div>

      <h2 className="mt-8 text-lg font-semibold">Cost per day</h2>
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card-elevated) p-5 shadow-sm">
        {costs.length === 0 ? (
          <EmptyState
            title="No costs recorded yet"
            hint="Daily cost buckets appear here once usage is reported."
          />
        ) : (
          costs.map((bucket) => (
            <div
              key={bucket.bucket_start}
              className="flex items-center gap-3 py-1"
            >
              <div className="w-28 shrink-0 font-mono text-xs text-(--color-fg-muted)">
                {bucket.bucket_start.slice(0, 10)}
              </div>
              <div className="h-4 flex-1 rounded bg-(--color-subtle-strong)">
                <div
                  className="h-4 rounded bg-(--color-accent)"
                  style={{
                    width: `${(bucket.cost_micro_usd / peak) * 100}%`,
                  }}
                />
              </div>
              <div className="w-24 shrink-0 text-right text-sm tabular-nums">
                {bucket.cost_micro_usd.toLocaleString("en-US")}
              </div>
            </div>
          ))
        )}
      </div>

      <h2 className="mt-8 text-lg font-semibold">Agents</h2>
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card-elevated) p-2 shadow-sm">
        <AgentTelemetryTable rows={agents} />
      </div>

      <BreakdownBars />

      <h2 className="mt-8 text-lg font-semibold">Latest usage</h2>
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card-elevated) p-2 shadow-sm">
        <UsageTable events={events} />
      </div>
    </div>
  );
}
