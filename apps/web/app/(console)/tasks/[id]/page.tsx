import Link from "next/link";
import { notFound } from "next/navigation";
import {
  apiUrl,
  sessionToken,
  ADMIN_COOKIE,
  type TaskDetail,
} from "@/lib/polymer";
import { AdminOverrides } from "./admin-overrides";
import { CommentForm } from "./comment-form";

async function fetchTaskDetail(id: string): Promise<TaskDetail | null> {
  const token = await sessionToken();
  const res = await fetch(`${apiUrl()}/api/tasks/${id}`, {
    headers: token ? { cookie: `${ADMIN_COOKIE}=${token}` } : {},
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`backend ${res.status}`);
  return (await res.json()) as TaskDetail;
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  const task = await fetchTaskDetail(id);
  if (task === null) notFound();
  return (
    <div>
      <Link
        href="/tasks"
        className="text-sm text-(--color-accent) hover:underline"
      >
        ← Tasks
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        {task.title}
      </h1>
      <dl className="mt-4 grid max-w-lg grid-cols-2 gap-2 text-sm">
        <dt className="text-gray-500">Status</dt>
        <dd className="font-mono">{task.status}</dd>
        <dt className="text-gray-500">Version</dt>
        <dd className="font-mono">{task.version}</dd>
        <dt className="text-gray-500">Lease generation</dt>
        <dd className="font-mono">{task.lease_generation}</dd>
        <dt className="text-gray-500">Coordinator</dt>
        <dd className="font-mono text-xs">{task.coordinator}</dd>
        <dt className="text-gray-500">Assigned to</dt>
        <dd className="font-mono text-xs">
          {task.assigned_to.join(", ") || "—"}
        </dd>
      </dl>
      {task.description && (
        <p className="mt-4 max-w-2xl text-sm">{task.description}</p>
      )}
      <h2 className="mt-6 text-lg font-medium">
        Comments{" "}
        {task.has_more && (
          <span className="text-sm text-gray-500">(latest 20)</span>
        )}
      </h2>
      <ul className="mt-2 max-w-2xl space-y-3">
        {task.comments.map((c) => (
          <li
            key={c.comment_id}
            className="rounded-md border border-(--color-hairline) bg-white p-3 text-sm"
          >
            <div className="font-mono text-xs text-gray-500">
              {c.sender_type === "human"
                ? "human operator"
                : c.sender_agent_id?.slice(0, 8)}{" "}
              · {c.created_at}
            </div>
            <p className="mt-1">{c.content}</p>
          </li>
        ))}
      </ul>
      <div className="max-w-2xl">
        <CommentForm taskId={task.task_id} />
      </div>
      <AdminOverrides task={task} />
    </div>
  );
}
