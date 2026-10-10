import { fetchAgents, fetchTasks } from "@/lib/polymer";

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
 * here. Telemetry summary cards wait for component 27.
 */
export default async function FleetPage(): Promise<React.JSX.Element> {
  const [agents, tasks] = await Promise.all([fetchAgents(), fetchTasks()]);
  const active = tasks.filter((t) => t.status === "in_progress").length;
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Fleet</h1>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card label="Agents" value={agents.length} />
        <Card label="Tasks" value={tasks.length} />
        <Card label="Active" value={active} />
      </div>
    </div>
  );
}
