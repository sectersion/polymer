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
        className="font-mono text-xs text-gray-500 underline"
      >
        ← Telemetry
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">
        Trace{" "}
        <span className="font-mono text-base text-gray-500">{trace_id}</span>
      </h1>
      <div className="mt-4 rounded-lg border border-(--color-hairline) bg-(--color-card) p-2 shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-(--color-hairline) text-left">
              <th className="px-3 py-2 font-medium text-gray-500">Span</th>
              <th className="px-3 py-2 font-medium text-gray-500">Name</th>
              <th className="px-3 py-2 font-medium text-gray-500">Status</th>
              <th className="px-3 py-2 font-medium text-gray-500">Agent</th>
            </tr>
          </thead>
          <tbody>
            {spans!.map((span) => (
              <tr
                key={span.span_id}
                className={
                  span.error
                    ? "border-b border-red-200 bg-red-50"
                    : "border-b border-(--color-hairline)"
                }
              >
                <td className="px-3 py-2 font-mono text-xs text-gray-500">
                  {span.span_id.slice(0, 8)}
                </td>
                <td className="px-3 py-2">{span.name}</td>
                <td className="px-3 py-2">
                  {span.error ? (
                    <span className="font-semibold text-red-600">
                      error
                      {span.status_message ? `: ${span.status_message}` : ""}
                    </span>
                  ) : (
                    <span className="text-gray-500">ok</span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-gray-500">
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
