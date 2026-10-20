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
import type { TimelineEventRow } from "@/lib/polymer";
import { EmptyState } from "../empty-state";

const helper = createColumnHelper<TimelineEventRow>();

const PAGE_SIZE = 10;

const columns = [
  helper.accessor("recorded_at", {
    header: "Recorded",
    cell: (info) => (
      <span className="font-mono text-xs text-(--color-fg-muted)">
        {info.getValue().slice(0, 19).replace("T", " ")}
      </span>
    ),
  }),
  helper.accessor("model", {
    header: "Model",
    cell: (info) => info.getValue() ?? "—",
  }),
  helper.accessor((row) => (row.input_tokens ?? 0) + (row.output_tokens ?? 0), {
    id: "tokens",
    header: "Tokens",
    cell: (info) => (
      <span className="tabular-nums">
        {(info.getValue() as number).toLocaleString("en-US")}
      </span>
    ),
  }),
  helper.accessor("reported_cost_micro_usd", {
    header: "Cost (µUSD)",
    cell: (info) => (
      <span className="tabular-nums">{info.getValue() ?? "—"}</span>
    ),
  }),
  helper.accessor("trace_id", {
    header: "Trace",
    enableSorting: false,
    cell: (info) =>
      info.getValue() ? (
        <a
          href={`/telemetry/trace/${info.getValue()}`}
          className="font-mono text-xs text-(--color-fg-muted) underline"
        >
          {info.getValue()?.slice(0, 8)}
        </a>
      ) : (
        <span className="font-mono text-xs text-(--color-fg-muted)">—</span>
      ),
  }),
];

export function UsageTable({ events }: { events: TimelineEventRow[] }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "recorded_at", desc: true },
  ]);

  const table = useReactTable({
    data: events,
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

  if (events.length === 0) {
    return (
      <EmptyState
        title="No usage recorded yet"
        hint="Spans with token counts will appear here once agents report inference."
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
          placeholder="Search model or trace…"
          aria-label="Search usage"
          className="rounded-md border border-(--color-hairline) bg-(--color-card) px-3 py-1.5 text-sm"
        />
      </div>
      {table.getRowModel().rows.length === 0 ? (
        <EmptyState
          title="No usage matches your search"
          hint="Try a different model name or trace prefix."
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
                    className="px-3 py-2 font-medium text-(--color-fg-muted)"
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
        <div className="flex items-center gap-3 p-1 text-sm text-(--color-fg-muted)">
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
