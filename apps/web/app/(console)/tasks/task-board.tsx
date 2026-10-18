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

const STATUS_BADGE: Record<string, { icon: string; label: string }> = {
  to_do: { icon: "○", label: "To do" },
  in_progress: { icon: "◐", label: "In progress" },
  done: { icon: "●", label: "Done" },
  failed: { icon: "✕", label: "Failed" },
};

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)";

function TaskCard({
  task,
  onMove,
}: {
  task: TaskItem;
  onMove: (task: TaskItem, status: string) => void;
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: task.task_id,
  });
  const badge = STATUS_BADGE[task.status] ?? {
    icon: "○",
    label: task.status,
  };
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className="cursor-grab rounded-md border border-(--color-hairline) bg-(--color-card) p-2 text-sm shadow-sm"
    >
      <Link
        href={`/tasks/${task.task_id}`}
        className={`font-medium hover:text-(--color-accent) ${FOCUS_RING}`}
        onClick={(e) => e.stopPropagation()}
      >
        {task.title}
      </Link>
      <div className="mt-1 font-mono text-xs text-gray-500">
        v{task.version} · gen {task.lease_generation}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-(--color-hairline) px-2 py-0.5 text-xs">
          <span aria-hidden="true">{badge.icon}</span> {badge.label}
        </span>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <span aria-hidden="true">Move to…</span>
          <select
            value={task.status}
            aria-label={`Move ${task.title} to status`}
            onChange={(e) => {
              if (e.target.value !== task.status) onMove(task, e.target.value);
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            className={`rounded border border-(--color-hairline) bg-white px-1 py-0.5 text-xs ${FOCUS_RING}`}
          >
            {COLUMNS.map((status) => (
              <option key={status} value={status}>
                {STATUS_BADGE[status]?.label ?? status}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

function Column({
  status,
  tasks,
  onMove,
}: {
  status: string;
  tasks: TaskItem[];
  onMove: (task: TaskItem, status: string) => void;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const badge = STATUS_BADGE[status] ?? { icon: "○", label: status };
  return (
    <section
      ref={setNodeRef}
      aria-label={`${badge.label} column`}
      className={`min-h-48 rounded-lg bg-gray-100/60 p-2 ${isOver ? "ring-2 ring-(--color-accent)" : ""}`}
    >
      <h2 className="px-1 py-1 font-mono text-xs font-semibold uppercase tracking-wide text-gray-500">
        <span aria-hidden="true">{badge.icon}</span> {badge.label} (
        {tasks.length})
      </h2>
      <div className="space-y-2">
        {tasks.length === 0 ? (
          <p className="rounded-md border border-dashed border-(--color-hairline) px-2 py-4 text-center text-xs text-gray-400">
            No {status} tasks
          </p>
        ) : (
          tasks.map((t) => (
            <TaskCard key={t.task_id} task={t} onMove={onMove} />
          ))
        )}
      </div>
    </section>
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
      {tasks.length === 0 && (
        <p className="rounded-lg border border-dashed border-(--color-hairline) bg-(--color-card) p-10 text-center text-sm text-gray-500 shadow-sm">
          No tasks yet — create one from the fleet dashboard or over MCP with
          create_task.
        </p>
      )}
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
              onMove={(task, next) => void moveTask(task, next)}
            />
          ))}
        </div>
      </DndContext>
    </div>
  );
}
