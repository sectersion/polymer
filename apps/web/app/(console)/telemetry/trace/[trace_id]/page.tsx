import Link from "next/link";
import { notFound } from "next/navigation";
import { backendGet } from "@/lib/polymer";
import type { TraceSpanRow } from "@/lib/polymer";

/**
 * Telemetry depth: read-only trace detail. Every span of the trace
 * ordered by start time; error spans (OTel status ERROR) highlighted.
 */
export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ trace_id: string }>;
}): Promise<React.JSX.Element> {
  const { trace_id } = await params;
  let spans: TraceSpanRow[];
  try {
    const body = await backendGet<{ trace_id: string; spans: TraceSpanRow[] }>(
      `/api/telemetry/traces/${trace_id}`,
    );
    spans = body.spans;
  } catch {
    notFound();
  }
  return (
    <div>
      <Link
        href="/telemetry"
        className="font-mono text-xs text-(--color-fg-muted) underline"
      >
        ← Telemetry
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Trace{" "}
        <span className="font-mono text-base text-(--color-fg-muted)">
          {trace_id}
        </span>
      </h1>
      <div className="mt-4 rounded-lg border border-(--color-hairline) bg-(--color-card) p-2 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-(--color-hairline) text-left">
              <th className="px-3 py-2 font-medium text-(--color-fg-muted)">
                Span
              </th>
              <th className="px-3 py-2 font-medium text-(--color-fg-muted)">
                Name
              </th>
              <th className="px-3 py-2 font-medium text-(--color-fg-muted)">
                Status
              </th>
              <th className="px-3 py-2 font-medium text-(--color-fg-muted)">
                Agent
              </th>
            </tr>
          </thead>
          <tbody>
            {spans!.map((span) => (
              <tr
                key={span.span_id}
                className={
                  span.error
                    ? "border-b border-(--color-danger-border) bg-(--color-danger-bg)"
                    : "border-b border-(--color-hairline)"
                }
              >
                <td className="px-3 py-2 font-mono text-xs text-(--color-fg-muted)">
                  {span.span_id.slice(0, 8)}
                </td>
                <td className="px-3 py-2">{span.name}</td>
                <td className="px-3 py-2">
                  {span.error ? (
                    <span className="font-semibold text-(--color-danger)">
                      error
                      {span.status_message ? `: ${span.status_message}` : ""}
                    </span>
                  ) : (
                    <span className="text-(--color-fg-muted)">ok</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-(--color-fg-muted)">
                  {span.agent_id.slice(0, 8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
