/** Fleet widget helpers: money formatting + sparkline geometry. Pure, unit-tested. */

/** Format integer micro-USD as dollars, with exact µUSD in title tooltip. */
export function formatUsd(microUsd: number): string {
  const dollars = microUsd / 1_000_000;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: dollars < 1 ? 4 : 2,
  }).format(dollars);
}

export function microUsdTooltip(microUsd: number): string {
  return `${microUsd.toLocaleString("en-US")} µUSD`;
}

/** Map cost buckets to SVG polyline points within w×h. */
export function sparkPoints(values: number[], w: number, h: number): string {
  if (values.length === 0) return "";
  const max = Math.max(...values, 1);
  return values
    .map((v, i) => {
      const x = values.length === 1 ? w / 2 : (i / (values.length - 1)) * w;
      const y = h - (v / max) * (h - 4) - 2;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** Donut segment offsets (fractions of 1) for task-status counts. */
export function donutSegments(
  counts: number[],
): { offset: number; frac: number }[] {
  const total = counts.reduce((a, b) => a + b, 0);
  let acc = 0;
  return counts.map((c) => {
    const frac = total === 0 ? 0 : c / total;
    const seg = { offset: acc, frac };
    acc += frac;
    return seg;
  });
}
