"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { AgentTelemetryRow } from "@/lib/polymer";

const helper = createColumnHelper<AgentTelemetryRow>();

const columns = [
  helper.accessor("name", { header: "Agent" }),
  helper.accessor("comments_sent", { header: "Comments" }),
  helper.accessor("tasks_created", { header: "Tasks" }),
  helper.accessor("tokens_used", {
    header: "Tokens",
    cell: (info) => (
      <span className="tabular-nums">
        {info.getValue().toLocaleString("en-US")}
      </span>
    ),
  }),
  helper.accessor("cost_micro_usd", {
    header: "Cost (µUSD)",
    cell: (info) => (
      <span className="tabular-nums">
        {info.getValue().toLocaleString("en-US")}
      </span>
    ),
  }),
];

export function AgentTelemetryTable({ rows }: { rows: AgentTelemetryRow[] }) {
  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <table className="w-full text-sm">
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr
            key={group.id}
            className="border-b border-(--color-hairline) text-left"
          >
            {group.headers.map((header) => (
              <th
                key={header.id}
                className="px-3 py-2 font-medium text-gray-500"
              >
                {flexRender(
                  header.column.columnDef.header,
                  header.getContext(),
                )}
              </th>
            ))}
          </tr>
        ))}
      </thead>
      <tbody>
        {table.getRowModel().rows.map((row) => (
          <tr key={row.id} className="border-b border-(--color-hairline)">
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} className="px-3 py-2">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
