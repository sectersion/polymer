"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TaskDetail } from "@/lib/polymer";

async function postJSON(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: res.ok, error: data.error };
}

/**
 * Component 20: the lease-bypassing admin affordances, every one
 * labeled as audit-logged. Normal paths carry the task's current
 * fences; force skips them.
 */
export function AdminOverrides({
  task,
}: {
  task: TaskDetail;
}): React.JSX.Element {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [agentIds, setAgentIds] = useState("");
  const [newCoordinator, setNewCoordinator] = useState("");
  const [status, setStatus] = useState("done");
  const [force, setForce] = useState(false);

  async function run(
    label: string,
    fn: () => Promise<{ ok: boolean; error?: string }>,
  ): Promise<void> {
    setBusy(true);
    setNotice(null);
    const out = await fn();
    setBusy(false);
    setNotice(
      out.ok
        ? `${label}: applied${force ? " (force — audit-logged)" : ""}.`
        : `${label} rejected (${out.error ?? "error"}).`,
    );
    router.refresh();
  }

  const fences = {
    expected_version: task.version,
    lease_generation: task.lease_generation,
  };

  return (
    <div className="mt-6 rounded-lg border border-(--color-hairline) bg-white p-4">
      <h2 className="font-medium">
        Admin overrides (lease-bypassing, audit-logged)
      </h2>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
        />
        Force (skip lease + fences)
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run("Claim", () =>
              postJSON(`/api/tasks/${task.task_id}/claim`, { force }),
            )
          }
          className="rounded-md border border-(--color-hairline) px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Force-claim
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run("Status", () =>
              postJSON(`/api/tasks/${task.task_id}`, {
                status,
                ...fences,
                force,
              }),
            )
          }
          className="rounded-md border border-(--color-hairline) px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Patch status
        </button>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-(--color-hairline) px-2 py-1 text-sm"
          aria-label="Target status"
        >
          {["to_do", "in_progress", "done", "failed"].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <input
          value={agentIds}
          onChange={(e) => setAgentIds(e.target.value)}
          placeholder="agent ids, comma-separated"
          className="rounded-md border border-(--color-hairline) px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          disabled={busy || agentIds.trim() === ""}
          onClick={() =>
            void run("Assign", () =>
              postJSON(`/api/tasks/${task.task_id}/assign`, {
                agent_ids: agentIds
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                ...fences,
                force,
              }),
            )
          }
          className="rounded-md border border-(--color-hairline) px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Assign
        </button>
        <input
          value={newCoordinator}
          onChange={(e) => setNewCoordinator(e.target.value)}
          placeholder="new coordinator id"
          className="rounded-md border border-(--color-hairline) px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          disabled={busy || newCoordinator.trim() === ""}
          onClick={() =>
            void run("Transfer", () =>
              postJSON(`/api/tasks/${task.task_id}/transfer-coordinator`, {
                new_coordinator_id: newCoordinator.trim(),
                ...fences,
                force,
              }),
            )
          }
          className="rounded-md border border-(--color-hairline) px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
        >
          Transfer
        </button>
      </div>
      {notice !== null && <p className="mt-3 text-sm">{notice}</p>}
    </div>
  );
}
