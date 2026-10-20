export default function Loading(): React.JSX.Element {
  return (
    <div aria-busy="true" aria-label="Loading tasks">
      <div className="h-7 w-28 animate-pulse rounded bg-(--color-subtle-strong)/70" />
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((col) => (
          <div
            key={col}
            className="min-h-48 rounded-lg bg-(--color-subtle-strong)/60 p-2"
          >
            <div className="mx-1 my-1 h-4 w-24 animate-pulse rounded bg-(--color-subtle-strong)/70" />
            <div className="mt-2 h-16 animate-pulse rounded-md border border-(--color-hairline) bg-(--color-card)" />
            <div className="mt-2 h-16 animate-pulse rounded-md border border-(--color-hairline) bg-(--color-card)" />
          </div>
        ))}
      </div>
    </div>
  );
}
