import {
  fetchAgentTelemetry,
  fetchDailyCosts,
  fetchSummary,
  fetchTimeline,
} from "@/lib/polymer";
import { AgentTelemetryTable } from "./agent-telemetry-table";

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm">
      <div className="text-sm text-gray-500">{label}</div>
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
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Telemetry</h1>
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
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm">
        {costs.map((bucket) => (
          <div
            key={bucket.bucket_start}
            className="flex items-center gap-3 py-1"
          >
            <div className="w-28 shrink-0 font-mono text-xs text-gray-500">
              {bucket.bucket_start.slice(0, 10)}
            </div>
            <div className="h-4 flex-1 rounded bg-gray-100">
              <div
                className="h-4 rounded bg-(--color-accent)"
                style={{ width: `${(bucket.cost_micro_usd / peak) * 100}%` }}
              />
            </div>
            <div className="w-24 shrink-0 text-right text-sm tabular-nums">
              {bucket.cost_micro_usd.toLocaleString("en-US")}
            </div>
          </div>
        ))}
      </div>

      <h2 className="mt-8 text-lg font-semibold">Agents</h2>
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card) p-2 shadow-sm">
        <AgentTelemetryTable rows={agents} />
      </div>

      <h2 className="mt-8 text-lg font-semibold">Latest usage</h2>
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card) p-2 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-(--color-hairline) text-left">
              <th className="px-3 py-2 font-medium text-gray-500">Recorded</th>
              <th className="px-3 py-2 font-medium text-gray-500">Model</th>
              <th className="px-3 py-2 font-medium text-gray-500">Tokens</th>
              <th className="px-3 py-2 font-medium text-gray-500">
                Cost (µUSD)
              </th>
              <th className="px-3 py-2 font-medium text-gray-500">Trace</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr
                key={event.usage_id}
                className="border-b border-(--color-hairline)"
              >
                <td className="px-3 py-2 font-mono text-xs text-gray-500">
                  {event.recorded_at.slice(0, 19).replace("T", " ")}
                </td>
                <td className="px-3 py-2">{event.model ?? "—"}</td>
                <td className="px-3 py-2 tabular-nums">
                  {(event.input_tokens ?? 0) + (event.output_tokens ?? 0)}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {event.reported_cost_micro_usd ?? "—"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500">
                  {event.trace_id?.slice(0, 8) ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
