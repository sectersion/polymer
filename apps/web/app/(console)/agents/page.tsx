import { fetchAgents } from "@/lib/polymer";
import { AgentsTable } from "./agents-table";

export default async function AgentsPage(): Promise<React.JSX.Element> {
  const agents = await fetchAgents();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
      <AgentsTable agents={agents} />
    </div>
  );
}
