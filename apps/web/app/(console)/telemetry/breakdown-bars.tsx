import React from "react";
import { fetchBreakdown, type BreakdownBucketRow } from "@/lib/polymer";

/** Proportional bar row shared by both breakdown dimensions. */
export function BreakdownRow({
  label,
  value,
  peak,
  detail,
}: {
  label: string;
  value: number;
  peak: number;
  detail: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="w-40 shrink-0 truncate font-mono text-xs text-(--color-fg-muted)">
        {label}
      </div>
      <div className="h-4 flex-1 rounded bg-(--color-subtle-strong)">
        <div
          className="h-4 rounded bg-(--color-accent)"
          style={{ width: `${peak > 0 ? (value / peak) * 100 : 0}%` }}
        />
      </div>
      <div className="w-40 shrink-0 text-right text-sm tabular-nums">
        {detail}
      </div>
    </div>
  );
}

/** Pure stacked-breakdown section (unit-testable without a backend). */
export function BreakdownSection({
  title,
  buckets,
}: {
  title: string;
  buckets: BreakdownBucketRow[];
}): React.JSX.Element {
  const peak = Math.max(1, ...buckets.map((b) => b.cost_micro_usd));
  return (
    <div>
      <h2 className="mt-8 text-lg font-semibold">{title}</h2>
      <div className="mt-2 rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm">
        {buckets.length === 0 ? (
          <div className="text-sm text-(--color-fg-muted)">
            No usage recorded.
          </div>
        ) : (
          buckets.map((bucket) => (
            <BreakdownRow
              key={bucket.key}
              label={bucket.key}
              value={bucket.cost_micro_usd}
              peak={peak}
              detail={`${bucket.cost_micro_usd.toLocaleString("en-US")} µUSD · ${bucket.tokens_used.toLocaleString("en-US")} tok`}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Telemetry depth: stacked model/provider cost bars. Server component
 * that fetches the new breakdown endpoint; existing cards untouched.
 */
export async function BreakdownBars(): Promise<React.JSX.Element> {
  const [models, providers] = await Promise.all([
    fetchBreakdown("model"),
    fetchBreakdown("provider"),
  ]);
  return (
    <div>
      <BreakdownSection title="Cost by model" buckets={models} />
      <BreakdownSection title="Cost by provider" buckets={providers} />
    </div>
  );
}
