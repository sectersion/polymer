import Link from "next/link";
import React from "react";

export function EmptyState({
  title,
  hint,
  actionHref,
  actionLabel,
}: {
  title: string;
  hint: string;
  actionHref?: string;
  actionLabel?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-(--color-hairline) bg-(--color-card) px-4 py-10 text-center shadow-sm">
      <p className="font-medium">{title}</p>
      <p className="text-sm text-(--color-fg-muted)">{hint}</p>
      {actionHref !== undefined && actionLabel !== undefined && (
        <Link
          href={actionHref}
          className="mt-1 text-sm font-medium text-(--color-accent) hover:underline"
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
