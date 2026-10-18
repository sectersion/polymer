import { describe, expect, it } from "vitest";
import {
  donutSegments,
  formatUsd,
  microUsdTooltip,
  sparkPoints,
} from "./format";

describe("fleet widgets", () => {
  it("formats micro-USD as dollars with tooltip", () => {
    expect(formatUsd(2_500_000)).toBe("$2.50");
    expect(microUsdTooltip(2500)).toBe("2,500 µUSD");
  });
  it("maps values to svg points", () => {
    expect(sparkPoints([], 220, 48)).toBe("");
    const pts = sparkPoints([0, 100], 220, 48);
    expect(pts.split(" ").length).toBe(2);
  });
  it("computes donut fractions summing to 1", () => {
    const segs = donutSegments([1, 1, 2, 0]);
    expect(segs.reduce((a, s) => a + s.frac, 0)).toBeCloseTo(1);
    expect(segs[0]!.offset).toBe(0);
  });
});
