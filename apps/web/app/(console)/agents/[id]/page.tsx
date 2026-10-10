import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchAgents, fetchTasks } from "@/lib/polymer";
import { apiUrl, sessionToken, ADMIN_COOKIE } from "@/lib/polymer";
import { DisableButton } from "./disable-button";

async function fetchAgent(id: string): Promise<{
  agent_id: string;
  name: string;
  role: string;
  parent_agent_id: string | null;
  status: string;
} | null> {
  const token = await sessionToken();
  const res = await fetch(`${apiUrl()}/api/agents/${id}`, {
    headers: token ? { cookie: `${ADMIN_COOKIE}=${token}` } : {},
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return (await res.json()) as {
    agent_id: string;
    name: string;
    role: string;
    parent_agent_id: string | null;
    status: string;
  };
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const [agent, agents, tasks] = await Promise.all([
    fetchAgent(id),
    fetchAgents(),
    fetchTasks(),
  ]);
  if (agent === null) notFound();
  const children = agents.filter((a) => a.parent_agent_id === agent.agent_id);
  const parent = agents.find((a) => a.agent_id === agent.parent_agent_id);
  const owned = tasks.filter((t) => t.coordinator === agent.agent_id);
  return (
    <div>
      <h1 className="font-mono text-2xl font-semibold tracking-tight">
        {agent.name}
      </h1>
      <dl className="mt-4 grid max-w-lg grid-cols-2 gap-2 text-sm">
        <dt className="text-gray-500">Role</dt>
        <dd>{agent.role}</dd>
        <dt className="text-gray-500">Status</dt>
        <dd>{agent.status}</dd>
        <dt className="text-gray-500">Parent</dt>
        <dd>
          {parent ? (
            <Link
              href={`/agents/${parent.agent_id}`}
              className="font-mono text-(--color-accent) hover:underline"
            >
              {parent.name}
            </Link>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <h2 className="mt-6 text-lg font-medium">Children</h2>
      {children.length === 0 ? (
        <p className="text-sm text-gray-500">None.</p>
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {children.map((c) => (
            <li key={c.agent_id}>
              <Link
                href={`/agents/${c.agent_id}`}
                className="font-mono text-(--color-accent) hover:underline"
              >
                {c.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <h2 className="mt-6 text-lg font-medium">Coordinated tasks</h2>
      {owned.length === 0 ? (
        <p className="text-sm text-gray-500">None.</p>
      ) : (
        <ul className="list-disc pl-5 text-sm">
          {owned.map((t) => (
            <li key={t.task_id}>
              <Link
                href={`/tasks/${t.task_id}`}
                className="text-(--color-accent) hover:underline"
              >
                {t.title}
              </Link>{" "}
              <span className="text-gray-500">({t.status})</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <DisableButton agentId={agent.agent_id} agentName={agent.name} />
      </div>
    </div>
  );
}
