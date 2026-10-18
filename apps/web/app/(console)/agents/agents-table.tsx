"use client";

import React from "react";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnFiltersState,
  type SortingState,
} from "@tanstack/react-table";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { Agent } from "@/lib/polymer";
import { EmptyState } from "../empty-state";

const columnsHelper = createColumnHelper<Agent>();

const STATUS_DOT: Record<string, string> = {
  idle: "bg-green-500",
  working: "bg-blue-500",
  error: "bg-red-500",
  disabled: "bg-gray-400",
};

const PAGE_SIZE = 10;

const columns = [
  columnsHelper.accessor("name", {
    header: "Name",
    enableSorting: true,
    cell: (info) => (
      <Link
        href={`/agents/${info.row.original.agent_id}`}
        className="font-mono text-(--color-accent) hover:underline"
      >
        {info.getValue()}
      </Link>
    ),
  }),
  columnsHelper.accessor("role", { header: "Role", enableSorting: true }),
  columnsHelper.accessor("status", {
    header: "Status",
    enableSorting: true,
    cell: (info) => (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-(--color-hairline) px-2 py-0.5">
        <span
          aria-hidden="true"
          className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[info.getValue()] ?? "bg-gray-300"}`}
        />
        {info.getValue()}
      </span>
    ),
  }),
  columnsHelper.accessor("agent_id", {
    header: "ID",
    enableSorting: false,
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
  const [globalFilter, setGlobalFilter] = useState("");
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [sorting, setSorting] = useState<SortingState>([
    { id: "name", desc: false },
  ]);

  const statuses = useMemo(
    () => [...new Set(agents.map((a) => a.status))].sort(),
    [agents],
  );

  const table = useReactTable({
    data: agents,
    columns,
    state: { globalFilter, columnFilters, sorting },
    onGlobalFilterChange: setGlobalFilter,
    onColumnFiltersChange: setColumnFilters,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  if (agents.length === 0) {
    return (
      <div className="mt-4">
        <EmptyState
          title="No agents yet"
          hint="Mint a token in Onboarding to enroll your first agent."
          actionHref="/onboarding"
          actionLabel="Go to Onboarding"
        />
      </div>
    );
  }

  const statusFilter =
    (table.getColumn("status")?.getFilterValue() as string | undefined) ?? "";
  const pageCount = table.getPageCount();
  const pageIndex = table.getState().pagination.pageIndex;

  return (
    <div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={globalFilter}
          onChange={(e) => {
            setGlobalFilter(e.target.value);
            table.setPageIndex(0);
          }}
          placeholder="Search name or role…"
          aria-label="Search agents"
          className="rounded-md border border-(--color-hairline) bg-(--color-card) px-3 py-1.5 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => {
            table
              .getColumn("status")
              ?.setFilterValue(
                e.target.value === "" ? undefined : e.target.value,
              );
            table.setPageIndex(0);
          }}
          aria-label="Filter by status"
          className="rounded-md border border-(--color-hairline) bg-(--color-card) px-2 py-1.5 text-sm"
        >
          <option value="">All statuses</option>
          {statuses.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {table.getRowModel().rows.length === 0 ? (
        <div className="mt-2">
          <EmptyState
            title="No agents match your search"
            hint="Try a different name, role, or status filter."
          />
        </div>
      ) : (
        <table className="mt-2 w-full border-collapse rounded-lg bg-(--color-card) text-sm shadow-sm">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-(--color-hairline)">
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    scope="col"
                    className="px-4 py-2 text-left font-medium text-gray-500"
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        aria-label={`Sort by ${String(header.column.columnDef.header)}`}
                        className="hover:text-(--color-accent)"
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {header.column.getIsSorted() === "asc"
                          ? " ▲"
                          : header.column.getIsSorted() === "desc"
                            ? " ▼"
                            : ""}
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )
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
      )}
      {pageCount > 1 && (
        <div className="mt-2 flex items-center gap-3 text-sm text-gray-500">
          <button
            type="button"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="rounded-md border border-(--color-hairline) px-2 py-1 disabled:opacity-40"
          >
            Previous
          </button>
          <span aria-live="polite">
            Page {pageIndex + 1} of {pageCount}
          </span>
          <button
            type="button"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="rounded-md border border-(--color-hairline) px-2 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
