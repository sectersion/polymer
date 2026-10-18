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
  type SortingState,
} from "@tanstack/react-table";
import { useState } from "react";
import type { AgentTelemetryRow } from "@/lib/polymer";
import { EmptyState } from "../empty-state";

const helper = createColumnHelper<AgentTelemetryRow>();

const PAGE_SIZE = 10;

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
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "tokens_used", desc: true },
  ]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { globalFilter, sorting },
    onGlobalFilterChange: setGlobalFilter,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  if (rows.length === 0) {
    return (
      <EmptyState
        title="No agent usage yet"
        hint="Usage appears here once agents send spans with token counts."
      />
    );
  }

  const pageCount = table.getPageCount();
  const pageIndex = table.getState().pagination.pageIndex;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 p-1">
        <input
          type="search"
          value={globalFilter}
          onChange={(e) => {
            setGlobalFilter(e.target.value);
            table.setPageIndex(0);
          }}
          placeholder="Search agents…"
          aria-label="Search agent usage"
          className="rounded-md border border-(--color-hairline) bg-(--color-card) px-3 py-1.5 text-sm"
        />
      </div>
      {table.getRowModel().rows.length === 0 ? (
        <EmptyState
          title="No agents match your search"
          hint="Try a different agent name."
        />
      ) : (
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
      )}
      {pageCount > 1 && (
        <div className="flex items-center gap-3 p-1 text-sm text-gray-500">
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
