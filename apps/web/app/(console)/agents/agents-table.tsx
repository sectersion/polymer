"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import Link from "next/link";
import type { Agent } from "@/lib/polymer";

const columnsHelper = createColumnHelper<Agent>();

const STATUS_DOT: Record<string, string> = {
  idle: "bg-green-500",
  working: "bg-blue-500",
  error: "bg-red-500",
  disabled: "bg-gray-400",
};

const columns = [
  columnsHelper.accessor("name", {
    header: "Name",
    cell: (info) => (
      <Link
        href={`/agents/${info.row.original.agent_id}`}
        className="font-mono text-(--color-accent) hover:underline"
      >
        {info.getValue()}
      </Link>
    ),
  }),
  columnsHelper.accessor("role", { header: "Role" }),
  columnsHelper.accessor("status", {
    header: "Status",
    cell: (info) => (
      <span className="inline-flex items-center gap-1.5">
        <span
          className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[info.getValue()] ?? "bg-gray-300"}`}
        />
        {info.getValue()}
      </span>
    ),
  }),
  columnsHelper.accessor("agent_id", {
    header: "ID",
    cell: (info) => (
      <span className="font-mono text-xs text-gray-500">
        {info.getValue().slice(0, 8)}
      </span>
    ),
  }),
];

export function AgentsTable({
  agents,
}: {
  agents: Agent[];
}): React.JSX.Element {
  const table = useReactTable({
    data: agents,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <table className="mt-4 w-full border-collapse rounded-lg bg-(--color-card) text-sm shadow-sm">
      <thead>
        {table.getHeaderGroups().map((group) => (
          <tr key={group.id} className="border-b border-(--color-hairline)">
            {group.headers.map((header) => (
              <th
                key={header.id}
                className="px-4 py-2 text-left font-medium text-gray-500"
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
          <tr
            key={row.id}
            className="border-b border-(--color-hairline) last:border-0"
          >
            {row.getVisibleCells().map((cell) => (
              <td key={cell.id} className="px-4 py-2">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
