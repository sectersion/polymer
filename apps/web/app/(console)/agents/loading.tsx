function ShimmerRow(): React.JSX.Element {
  return (
    <div className="flex gap-3 px-4 py-3">
      <div className="h-4 flex-1 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="h-4 w-20 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="h-4 w-16 animate-pulse rounded bg-(--color-subtle-strong)/70" />
    </div>
  );
}

export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading agents">
      <div className="h-7 w-32 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="mt-4 divide-y divide-(--color-hairline) rounded-lg border border-(--color-hairline) bg-(--color-card) shadow-sm">
        <ShimmerRow />
        <ShimmerRow />
        <ShimmerRow />
        <ShimmerRow />
      </div>
    </div>
  );
}
