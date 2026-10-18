import Link from "next/link";
import type {
  Agent,
  AgentTelemetryRow,
  CostBucket,
  TaskItem,
  TimelineEventRow,
} from "@/lib/polymer";
import {
  donutSegments,
  formatUsd,
  microUsdTooltip,
  sparkPoints,
} from "./format";

export function CostSparkline({
  buckets,
}: {
  buckets: CostBucket[];
}): React.JSX.Element {
  const values = buckets.map((b) => b.cost_micro_usd);
  const pts = sparkPoints(values, 220, 48);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <Link
      href="/telemetry"
      className="block rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm"
      data-testid="fleet-cost-spark"
      title={microUsdTooltip(total)}
    >
      <div className="text-sm text-gray-500">7-day cost</div>
      <div className="mt-1 text-2xl font-semibold">{formatUsd(total)}</div>
      {pts ? (
        <svg
          viewBox="0 0 220 48"
          className="mt-2 h-12 w-full"
          role="img"
          aria-label="7-day cost trend"
        >
          <polyline
            points={pts}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          />
        </svg>
      ) : (
        <p className="mt-2 text-sm text-gray-500">No cost data yet</p>
      )}
    </Link>
  );
}

const TASK_STATUSES = ["to_do", "in_progress", "done", "failed"] as const;
const DONUT_COLORS = ["#94a3b8", "#3b82f6", "#22c55e", "#ef4444"];

export function TaskDonut({ tasks }: { tasks: TaskItem[] }): React.JSX.Element {
  const counts = TASK_STATUSES.map(
    (s) => tasks.filter((t) => t.status === s).length,
  );
  const segs = donutSegments(counts).map((s, i) => ({
    ...s,
    color: DONUT_COLORS[i]!,
  }));
  return (
    <div
      className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm"
      data-testid="fleet-task-donut"
    >
      <div className="text-sm text-gray-500">Tasks by status</div>
      <div className="mt-2 flex items-center gap-4">
        <svg
          viewBox="0 0 42 42"
          className="h-20 w-20"
          role="img"
          aria-label="task status donut"
        >
          <circle
            cx="21"
            cy="21"
            r="15.9"
            fill="none"
            strokeWidth="8"
            className="stroke-gray-200"
          />
          {segs.map((s, i) =>
            s.frac > 0 ? (
              <circle
                key={TASK_STATUSES[i]}
                cx="21"
                cy="21"
                r="15.9"
                fill="none"
                stroke={s.color}
                strokeWidth="8"
                strokeDasharray={`${(s.frac * 100).toFixed(1)} 100`}
                strokeDashoffset={(-s.offset * 100).toFixed(1)}
                transform="rotate(-90 21 21)"
              />
            ) : null,
          )}
        </svg>
        <ul className="space-y-1 text-sm">
          {TASK_STATUSES.map((s, i) => (
            <li key={s}>
              <Link
                href={`/tasks?status=${s}`}
                className="underline-offset-2 hover:underline"
              >
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-full"
                  style={{ background: DONUT_COLORS[i] }}
                />
                {s}: {counts[i]}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function AgentStrip({
  agents,
  telemetry,
}: {
  agents: Agent[];
  telemetry: AgentTelemetryRow[];
}): React.JSX.Element {
  const byId = new Map(telemetry.map((t) => [t.agent_id, t]));
  return (
    <div
      className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm"
      data-testid="fleet-agent-strip"
    >
      <div className="text-sm text-gray-500">Agents</div>
      <ul className="mt-2 flex flex-wrap gap-2">
        {agents.map((a) => (
          <li key={a.agent_id}>
            <Link
              href={`/agents/${a.agent_id}`}
              title={microUsdTooltip(byId.get(a.agent_id)?.cost_micro_usd ?? 0)}
              className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm hover:bg-gray-100"
            >
              <span
                className={`inline-block h-2 w-2 rounded-full ${a.status === "active" ? "bg-green-500" : "bg-gray-400"}`}
              />
              {a.name}
            </Link>
          </li>
        ))}
        {agents.length === 0 && (
          <li className="text-sm text-gray-500">No agents</li>
        )}
      </ul>
    </div>
  );
}

export function RecentEvents({
  events,
}: {
  events: TimelineEventRow[];
}): React.JSX.Element {
  return (
    <div
      className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm"
      data-testid="fleet-recent-events"
    >
      <div className="text-sm text-gray-500">Recent events</div>
      <ul className="mt-2 space-y-1 text-sm">
        {events.slice(0, 8).map((e) => (
          <li
            key={`${e.usage_id}-${e.task_id ?? e.agent_id ?? "fleet"}-${e.recorded_at}`}
          >
            {e.task_id ? (
              <Link href={`/tasks/${e.task_id}`} className="hover:underline">
                {e.model ?? "event"} · {e.input_tokens ?? 0}+
                {e.output_tokens ?? 0} tokens
              </Link>
            ) : (
              <Link
                href={e.agent_id ? `/agents/${e.agent_id}` : "/telemetry"}
                className="hover:underline"
              >
                {e.model ?? "event"} · {e.input_tokens ?? 0}+
                {e.output_tokens ?? 0} tokens
              </Link>
            )}{" "}
            <span className="text-gray-500">
              {new Date(e.recorded_at).toLocaleString()}
            </span>
          </li>
        ))}
        {events.length === 0 && (
          <li className="text-gray-500">No events yet</li>
        )}
      </ul>
    </div>
  );
}
