"use client";

import {
  DndContext,
  useDraggable,
  useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TaskItem } from "@/lib/polymer";
import { pushToast } from "@/lib/toasts";

const COLUMNS = ["to_do", "in_progress", "done", "failed"] as const;

function TaskCard({ task }: { task: TaskItem }): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: task.task_id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="cursor-grab rounded-md border border-(--color-hairline) bg-(--color-card) p-2 text-sm shadow-sm"
    >
      <Link
        href={`/tasks/${task.task_id}`}
        className="font-medium hover:text-(--color-accent)"
        onClick={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>
      <div className="mt-1 font-mono text-xs text-gray-500">
        v{task.version} · gen {task.lease_generation}
      </div>
    </div>
  );
}

function Column({
  status,
  tasks,
}: {
  status: string;
  tasks: TaskItem[];
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={`min-h-48 rounded-lg bg-gray-100/60 p-2 ${isOver ? "ring-2 ring-(--color-accent)" : ""}`}
    >
      <h2 className="px-1 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-gray-500">
        {status} ({tasks.length})
      </h2>
      <div className="space-y-2">
        {tasks.map((t) => (
          <TaskCard key={t.task_id} task={t} />
        ))}
      </div>
    </div>
  );
}

/**
 * Component 20: the admin task board. Drops go through the
 * PATCH/force contract with the task's current fences; failures
 * (illegal transitions, stale fences) surface inline, and forced
 * drops carry an audit notice.
 */
export function TaskBoard({
  initial,
}: {
  initial: TaskItem[];
}): React.JSX.Element {
  const router = useRouter();
  const [force, setForce] = useState(false);
  const [tasks, setTasks] = useState(initial);

  async function revertMove(
    taskId: string,
    status: string,
    expectedVersion: number,
    leaseGeneration: number,
  ): Promise<void> {
    const res = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        expected_version: expectedVersion,
        lease_generation: leaseGeneration,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      version?: number;
    };
    if (!res.ok) {
      pushToast({
        kind: "error",
        message: `Undo rejected (${body.error ?? res.status}).`,
      });
      return;
    }
    setTasks((prev) =>
      prev.map((t) =>
        t.task_id === taskId
          ? { ...t, status, version: body.version ?? expectedVersion }
          : t,
      ),
    );
    pushToast({ kind: "success", message: `Undone (v${body.version}).` });
    router.refresh();
  }

  async function moveTask(task: TaskItem, status: string): Promise<void> {
    const previousStatus = task.status;
    const res = await fetch(`/api/tasks/${task.task_id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status,
        expected_version: task.version,
        lease_generation: task.lease_generation,
        force,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      version?: number;
    };
    if (!res.ok) {
      pushToast({
        kind: "error",
        message: `Move rejected (${body.error ?? res.status}). No change applied.`,
      });
      return;
    }
    // Thread the post-move version into the undo closure: the snapshot
    // taken before the move is already superseded and would 409.
    const next = { ...task, status, version: body.version ?? task.version };
    setTasks((prev) =>
      prev.map((t) => (t.task_id === task.task_id ? next : t)),
    );
    pushToast({
      kind: "success",
      message: force
        ? `Moved with force — lease bypass, audit-logged (v${body.version}).`
        : `Moved to ${status} (v${body.version}).`,
      actionLabel: "Undo",
      onAction: () =>
        void revertMove(
          task.task_id,
          previousStatus,
          next.version,
          task.lease_generation,
        ),
    });
    router.refresh();
  }

  async function onDragEnd(event: DragEndEvent): Promise<void> {
    const { active, over } = event;
    if (over === null || over.id === active.id) return;
    const task = tasks.find((t) => t.task_id === active.id);
    if (task === undefined || task.status === over.id) return;
    await moveTask(task, String(over.id));
  }

  return (
    <div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={force}
          onChange={(e) => setForce(e.target.checked)}
        />
        Force drop (lease-bypassing, audit-logged)
      </label>
      <DndContext onDragEnd={(e) => void onDragEnd(e)}>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-4">
          {COLUMNS.map((status) => (
            <Column
              key={status}
              status={status}
              tasks={tasks.filter((t) => t.status === status)}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
