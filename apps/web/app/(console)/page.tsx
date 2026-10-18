import Link from "next/link";
import {
  fetchAgentTelemetry,
  fetchAgents,
  fetchDailyCosts,
  fetchSummary,
  fetchTasks,
  fetchTimeline,
} from "@/lib/polymer";
import { FleetLive } from "./fleet-live";
import {
  AgentStrip,
  CostSparkline,
  RecentEvents,
  TaskDonut,
} from "./fleet/widgets";
import { formatUsd, microUsdTooltip } from "./fleet/format";

function Card({
  href,
  label,
  title,
  value,
}: {
  href: string;
  label: string;
  title?: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      className="block rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm"
      href={href}
      title={title}
    >
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </Link>
  );
}

/**
 * Component 20 + fleet widget expansion: clickable cards over the
 * existing REST endpoints (no new backend routes). Server-rendered
 * counts stay tabular-nums in Agents/Tasks/Active/Tokens/Cost order
 * (fleet.test.ts pins this); cost also shows $ with a µUSD tooltip.
 */
export default async function FleetPage(): Promise<React.JSX.Element> {
  const [agents, tasks, summary, buckets, events, agentTelemetry] =
    await Promise.all([
      fetchAgents(),
      fetchTasks(),
      fetchSummary(),
      fetchDailyCosts(7),
      fetchTimeline(8),
      fetchAgentTelemetry(),
    ]);
  const active = tasks.filter((t) => t.status === "in_progress").length;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Fleet</h1>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card href="/agents" label="Agents" value={agents.length} />
        <Card href="/tasks" label="Tasks" value={tasks.length} />
        <Card href="/tasks?status=in_progress" label="Active" value={active} />
        <Card
          href="/telemetry"
          label="Tokens"
          value={summary.total_tokens_used}
        />
        <Card
          href="/telemetry"
          label="Cost"
          title={microUsdTooltip(summary.total_cost_micro_usd)}
          value={formatUsd(summary.total_cost_micro_usd)}
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CostSparkline buckets={buckets} />
        <TaskDonut tasks={tasks} />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <AgentStrip agents={agents} telemetry={agentTelemetry} />
        <RecentEvents events={events} />
      </div>
      <FleetLive />
    </div>
  );
}
