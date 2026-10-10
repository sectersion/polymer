"use client";

import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { TokenRow } from "@/lib/polymer";

const helper = createColumnHelper<TokenRow>();

function RevokeButton({ id }: { id: string }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function revoke(): Promise<void> {
    setBusy(true);
    await fetch(`/api/tokens/${id}`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }
  return (
    <button
      type="button"
      onClick={() => void revoke()}
      disabled={busy}
      className="rounded-md border border-(--color-hairline) px-2 py-0.5 text-xs hover:bg-gray-50 disabled:opacity-50"
    >
      Revoke
    </button>
  );
}

const columns = [
  helper.accessor("public_id", {
    header: "Public ID",
    cell: (info) => (
      <span className="font-mono text-xs">{info.getValue() ?? "—"}</span>
    ),
  }),
  helper.accessor("type", { header: "Type" }),
  helper.accessor("status", { header: "Status" }),
  helper.accessor("agent_id", {
    header: "Agent",
    cell: (info) => (
      <span className="font-mono text-xs">
        {info.getValue()?.slice(0, 8) ?? "—"}
      </span>
    ),
  }),
  helper.accessor("expires_at", {
    header: "Expires",
    cell: (info) => (
      <span className="font-mono text-xs">{info.getValue() ?? "—"}</span>
    ),
  }),
  helper.display({
    id: "actions",
    header: "Actions",
    cell: (info) => <RevokeButton id={info.row.original.credential_id} />,
  }),
];

export function TokensTable({
  tokens,
}: {
  tokens: TokenRow[];
}): React.JSX.Element {
  const table = useReactTable({
    data: tokens,
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
