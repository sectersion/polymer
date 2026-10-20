function ShimmerCard(): React.JSX.Element {
  return (
    <div className="rounded-lg border border-(--color-hairline) bg-(--color-card) p-5 shadow-sm">
      <div className="h-4 w-20 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="mt-2 h-8 w-24 animate-pulse rounded bg-(--color-subtle-strong)/70" />
    </div>
  );
}

export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading telemetry">
      <div className="h-7 w-36 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <ShimmerCard />
        <ShimmerCard />
        <ShimmerCard />
        <ShimmerCard />
        <ShimmerCard />
      </div>
      <div className="mt-8 h-6 w-32 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="mt-2 h-40 animate-pulse rounded-lg border border-(--color-hairline) bg-(--color-card)" />
    </div>
  );
}
