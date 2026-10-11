import { fetchAgents, fetchSummary, fetchTasks } from "@/lib/polymer";
import { FleetLive } from "./fleet-live";

function Card({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm">
      <div className="text-sm text-gray-500">{label}</div>
      <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/**
 * Component 20: the Fleet dashboard. Server-rendered counts straight
 * off the REST endpoints — the win condition is seeing live MCP data
 * here. Tokens + cost cards arrived with the component-27 summary.
 */
export default async function FleetPage(): Promise<React.JSX.Element> {
  const [agents, tasks, summary] = await Promise.all([
    fetchAgents(),
    fetchTasks(),
    fetchSummary(),
  ]);
  const active = tasks.filter((t) => t.status === "in_progress").length;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Fleet</h1>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <Card label="Agents" value={agents.length} />
        <Card label="Tasks" value={tasks.length} />
        <Card label="Active" value={active} />
        <Card label="Tokens" value={summary.total_tokens_used} />
        <Card label="Cost (µUSD)" value={summary.total_cost_micro_usd} />
      </div>
      <FleetLive />
    </div>
  );
}
